export * as CompatMcpJson from "./mcp-json.js"

import { Effect, Option, Schema } from "effect"
import { Document, Info } from "@orbit/schema/config"
import { Mcp } from "@orbit/schema/mcp"
import type { AbsolutePath } from "@orbit/schema/schema"
import { FSUtil } from "@orbit/util/fs-util"
import { LinkShare } from "@orbit/util/link-share"
import type { CompatDiagnostic } from "./diagnostic.js"

/**
 * The file that other agent products use to declare a project's MCP servers, read as one project-scope document.
 * Servers that talk over standard input and output become local servers, and those that talk over HTTP or SSE become
 * remote ones. A server that cannot be mapped is skipped and reported, and the rest still come through.
 */

type Variables = Readonly<Record<string, string | undefined>>
type Failure = Pick<CompatDiagnostic.Info, "kind" | "message">
type Conversion = { readonly server: Record<string, unknown> } | { readonly failure: Failure }

// The fields Orbit maps. Any other field belongs to the product that writes the file and does not come through.
const Entry = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  command: Schema.optionalKey(Schema.String),
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  cwd: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
})
type Entry = typeof Entry.Type

// The servers are decoded one by one, so a server that cannot be read costs only itself.
const Contents = Schema.Struct({ mcpServers: Schema.optionalKey(Schema.Unknown) })
const decodeContents = Schema.decodeUnknownOption(Schema.fromJsonString(Contents))
const decodeEntries = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))
const decodeEntry = Schema.decodeUnknownOption(Entry)
const decodeServer = Schema.decodeUnknownOption(Mcp.ServerConfig)
const decodeInfo = Schema.decodeUnknownOption(Info, {
  errors: "all",
  onExcessProperty: "ignore",
  propertyOrder: "original",
})

// `${NAME}` is the variable, and `${NAME:-fallback}` is the variable, or the fallback when it is unset or empty.
const reference = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

const malformed: Failure = { kind: "invalid", message: "skipped malformed recognized value" }
const empty: CompatDiagnostic.Result = { documents: [], diagnostics: [] }

/**
 * Reads a project's file, `.mcp.json` in the project directory, into a project-scope document, or into nothing when it
 * is missing, unreadable, not JSON, or holds no server that can be mapped. References to variables are expanded from
 * `env` in every command, argument, variable, directory, URL and header, and a server that names a variable that is
 * unset, with no fallback, is skipped, as the product that writes the file refuses it.
 */
export const read = Effect.fn("CompatMcpJson.read")(function* (input: {
  /** The file to read. */
  readonly file: AbsolutePath
  /** The environment that variable references are expanded from. */
  readonly env: Variables
}) {
  const fs = yield* FSUtil.Service
  const text = (yield* LinkShare.blocked(fs, input.file))
    ? undefined
    : yield* fs.readFileStringSafe(input.file).pipe(Effect.orElseSucceed(() => undefined))
  return text === undefined ? empty : parse(text, input.file, input.env)
})

function parse(text: string, source: AbsolutePath, variables: Variables): CompatDiagnostic.Result {
  const problem = (kind: CompatDiagnostic.Info["kind"], where: readonly string[], message: string) =>
    ({ source, kind, path: where, message }) satisfies CompatDiagnostic.Info

  const decoded = decodeContents(text)
  if (Option.isNone(decoded))
    return { documents: [], diagnostics: [problem("invalid", ["$"], "rejected malformed JSON document")] }
  if (decoded.value.mcpServers === undefined) return empty
  const entries = decodeEntries(decoded.value.mcpServers)
  if (Option.isNone(entries))
    return { documents: [], diagnostics: [problem(malformed.kind, ["mcpServers"], malformed.message)] }

  const converted = Object.entries(entries.value).map(([name, raw]) => ({ name, result: convert(raw, variables) }))
  const diagnostics = converted.flatMap(({ name, result }) =>
    "failure" in result ? [problem(result.failure.kind, ["mcpServers", name], result.failure.message)] : [],
  )
  const servers = Object.fromEntries(
    converted.flatMap(({ name, result }) => ("server" in result ? [[name, result.server]] : [])),
  )
  if (Object.keys(servers).length === 0) return { documents: [], diagnostics }

  const info = decodeInfo({ mcp: { servers } })
  if (Option.isNone(info))
    return {
      documents: [],
      diagnostics: [
        ...diagnostics,
        problem("invalid", ["$"], "rejected canonical configuration after final validation"),
      ],
    }
  return {
    documents: [new Document({ type: "document", path: source, scope: "project", info: info.value })],
    diagnostics,
  }
}

function convert(raw: unknown, variables: Variables): Conversion {
  const entry = decodeEntry(raw)
  if (Option.isNone(entry)) return { failure: malformed }
  const type = entry.value.type ?? "stdio"
  const mapped =
    type === "stdio"
      ? local(entry.value, variables)
      : type === "http" || type === "sse"
        ? remote(entry.value, type, variables)
        : { failure: { kind: "unsupported", message: "omitted server of an unknown type" } satisfies Failure }
  if ("failure" in mapped) return mapped
  // Checked as Orbit reads it, so only a server the MCP service can start comes through.
  return Option.isSome(decodeServer(mapped.server)) ? mapped : { failure: malformed }
}

function local(entry: Entry, variables: Variables): Conversion {
  if (!entry.command) return { failure: { kind: "invalid", message: "skipped server without a command" } }
  const unset = unresolved(
    [
      entry.command,
      ...(entry.args ?? []),
      ...Object.values(entry.env ?? {}),
      ...(entry.cwd === undefined ? [] : [entry.cwd]),
    ],
    variables,
  )
  if (unset.length > 0) return unsetFailure(unset)
  const expand = expander(variables)
  return {
    server: {
      type: "local",
      command: [expand(entry.command), ...(entry.args ?? []).map(expand)],
      ...(entry.env === undefined ? {} : { environment: expandValues(entry.env, expand) }),
      ...(entry.cwd === undefined ? {} : { cwd: expand(entry.cwd) }),
    },
  }
}

function remote(entry: Entry, type: "http" | "sse", variables: Variables): Conversion {
  if (!entry.url) return { failure: { kind: "invalid", message: "skipped server without a url" } }
  const unset = unresolved([entry.url, ...Object.values(entry.headers ?? {})], variables)
  if (unset.length > 0) return unsetFailure(unset)
  const expand = expander(variables)
  return {
    server: {
      type: "remote",
      url: expand(entry.url),
      transport: type === "sse" ? "sse" : "streamable-http",
      ...(entry.headers === undefined ? {} : { headers: expandValues(entry.headers, expand) }),
    },
  }
}

/** What a reference stands for: undefined when it names a variable that is unset and has no fallback. */
function resolve(variables: Variables, name: string, fallback: string | undefined) {
  const current = variables[name]
  if (fallback === undefined) return current
  return current === undefined || current === "" ? fallback : current
}

/** The names of the variables that `values` refer to and that cannot be resolved, each once. */
function unresolved(values: readonly string[], variables: Variables) {
  const names = values.flatMap((value) =>
    [...value.matchAll(reference)].flatMap(([, name, fallback]) =>
      resolve(variables, name, fallback) === undefined ? [name] : [],
    ),
  )
  return [...new Set(names)]
}

function expander(variables: Variables) {
  return (value: string) =>
    value.replace(
      reference,
      (_match, name: string, fallback: string | undefined) => resolve(variables, name, fallback) ?? "",
    )
}

function expandValues(values: Readonly<Record<string, string>>, expand: (value: string) => string) {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, expand(value)]))
}

function unsetFailure(names: readonly string[]): Conversion {
  return {
    failure: {
      kind: "invalid",
      message: `skipped server that refers to unset environment variables: ${names.join(", ")}`,
    },
  }
}
