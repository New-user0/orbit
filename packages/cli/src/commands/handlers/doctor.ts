import { Orbit } from "@orbit/client"
import { Service } from "@orbit/client/effect/service"
import { ManagedPath } from "@orbit/util/managed-path"
import { Network } from "@orbit/util/network"
import { plain } from "@orbit/util/plain"
import { Effect, Option } from "effect"
import { EOL } from "node:os"
import path from "node:path"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { sandboxCheck, sandboxState } from "../../util/doctor-sandbox"
import { settledModels } from "../../util/models"
import { requireTrust } from "../../util/trust"
import { directory } from "./flow/execute"
import { ORBIT_VERSION } from "../../version"

// Names only: doctor output is meant to be pasted into a bug report, so it never prints a value.
const tachyonVariables = [
  "TACHYON_CHAT_COMPLETION_BASE_URL",
  "TACHYON_APIGEE_URL",
  "TACHYON_CONSUMER_KEY",
  "TACHYON_CONSUMER_SECRET",
  "TACHYON_API_KEY",
  "TACHYON_USECASE_ID",
  "TACHYON_USE_API_GATEWAY",
]
const proxyVariables = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]

type Check = { readonly ok: boolean | undefined; readonly label: string; readonly detail: string }

export default Runtime.handler(
  Commands.commands.doctor,
  Effect.fn("cli.doctor")(function* (input) {
    const model = Option.getOrUndefined(input.model)
    const { ServerManaged } = yield* Effect.promise(() => import("@orbit/server/managed"))
    const managed = yield* ServerManaged.read(ManagedPath.directory(process.platform, process.env))
    // The runner's own answer to "what would a shell command meet", so the line cannot disagree with it.
    const probed = ServerManaged.sandboxProbe()
    const checks = [
      { ok: undefined, label: "orb", detail: `${ORBIT_VERSION} on ${process.platform}-${process.arch}` },
      network(),
      {
        ok: undefined,
        label: "proxy",
        detail: names(proxyVariables) || "none (direct connections)",
      },
      ripgrep(),
      git(),
      sandboxCheck(probed, sandboxState(managed.info.sandbox)),
      tachyon(),
      ...managedChecks(managed),
    ] satisfies Check[]
    print(checks)
    if (!input.probe && model === undefined) {
      process.stdout.write(`${EOL}Run \`orb doctor --probe\` to send one short request to each provider.${EOL}`)
      return finish(checks)
    }

    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
      trust: input.trust,
    })
    const client = Orbit.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
    // A probe starts a session in this folder, which an untrusted folder refuses, so the folder is asked about first and
    // the refusal says how to trust it, rather than the probe failing on the server's answer (class 12).
    yield* requireTrust(client, directory(), { grant: input.trust })
    // The models are listed for the folder that was asked about and that the probe starts its session in (class 3).
    const available = yield* Effect.promise(() => settledModels(client, directory(), model))
    const targets =
      model === undefined
        ? [...new Map(available.map((item) => [item.providerID, `${item.providerID}/${item.id}`])).values()]
        : [model]
    process.stdout.write(`${EOL}Probing ${targets.length} model(s) with "Reply with ok"${EOL}`)
    const probes = yield* Effect.forEach(targets, (target) => Effect.promise(() => probe(client, target)))
    print(probes)
    // Probing loaded the Ollama models, so the server can now say which context window it actually serves.
    const served = targets.some((target) => target.startsWith("ollama/"))
      ? yield* Effect.promise(() => ollamaContext(client))
      : []
    print(served)
    return finish([...checks, ...probes, ...served])
  }),
)

function network(): Check {
  // Startup already installed these settings and would have stopped on an unreadable file.
  const configured = Network.settings()
  if (!configured) return { ok: undefined, label: "tls", detail: "bundled and OS trust store" }
  const certificates = configured.ca.reduce(
    (count, pem) => count + (pem.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0),
    0,
  )
  return {
    ok: certificates > 0 || configured.cert !== undefined,
    label: "tls",
    detail: [
      `${names(["ORBIT_CA_CERTS", "TACHYON_CERT_PATH", "TACHYON_CERT_B64"])} add ${certificates} certificate(s) to the bundled and OS trust store`,
      ...(configured.cert ? ["client certificate configured (mutual TLS)"] : []),
    ].join("; "),
  }
}

// The managed settings files by name, relative to their folder, and what could not be used in them; never a value.
function managedChecks(managed: {
  readonly directory: string
  readonly sources: readonly string[]
  readonly diagnostics: readonly { readonly source: string; readonly path: string; readonly message: string }[]
}): Check[] {
  return [
    managed.sources.length === 0
      ? { ok: undefined, label: "managed", detail: `no managed settings in ${managed.directory}` }
      : {
          ok: undefined,
          label: "managed",
          detail: plain(managed.sources.map((source) => path.relative(managed.directory, source)).join(", ")),
        },
    ...managed.diagnostics.map(
      (diagnostic): Check => ({
        ok: false,
        label: "managed",
        detail: plain(
          `${path.relative(managed.directory, diagnostic.source)} ${diagnostic.path}: ${diagnostic.message}`,
        ),
      }),
    ),
  ]
}

function ripgrep(): Check {
  const found = Bun.which("rg")
  return found
    ? { ok: true, label: "ripgrep", detail: found }
    : { ok: false, label: "ripgrep", detail: "rg is not on PATH; search tools need it" }
}

// orb flow needs git for its worktrees and merges; everything else works without it.
function git(): Check {
  const found = Bun.which("git")
  return found
    ? { ok: true, label: "git", detail: found }
    : { ok: undefined, label: "git", detail: "git is not on PATH; orb flow runs without worktrees or merges" }
}

function tachyon(): Check {
  const set = tachyonVariables.filter((name) => process.env[name])
  if (set.length === 0) return { ok: undefined, label: "tachyon", detail: "not configured" }
  const gateway = process.env.TACHYON_USE_API_GATEWAY?.toLowerCase() !== "false"
  const required = [
    "TACHYON_CHAT_COMPLETION_BASE_URL",
    "TACHYON_API_KEY",
    "TACHYON_USECASE_ID",
    ...(gateway ? ["TACHYON_APIGEE_URL", "TACHYON_CONSUMER_KEY", "TACHYON_CONSUMER_SECRET"] : []),
  ]
  const missing = required.filter((name) => !process.env[name])
  return missing.length === 0
    ? { ok: true, label: "tachyon", detail: `set: ${set.join(", ")}` }
    : { ok: false, label: "tachyon", detail: `missing: ${missing.join(", ")}` }
}

async function probe(client: ReturnType<typeof Orbit.make>, target: string): Promise<Check> {
  const separator = target.indexOf("/")
  if (separator <= 0) return { ok: false, label: target, detail: "expected provider/model" }
  const model = { providerID: target.slice(0, separator), id: target.slice(separator + 1) }
  const started = Date.now()
  // A throwaway session resolves the model with this directory's configuration, as a real session would.
  const session = await client.session.create({ title: "orb doctor", model, location: { directory: directory() } })
  return client.session
    .generate({ sessionID: session.id, prompt: "Reply with ok" })
    .then(
      (result) => ({
        ok: true,
        label: target,
        detail: `${Date.now() - started} ms: ${result.text.trim().slice(0, 40)}`,
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        // A rate limit proves the provider accepted the credentials and the request.
        const limited = /\b429\b|rate.?limit|too many requests/i.test(message)
        return { ok: limited, label: target, detail: limited ? `reachable, rate limited: ${message}` : message }
      },
    )
    .finally(() => client.session.remove({ sessionID: session.id }).catch(() => undefined))
}

// Below this, Orbit's system prompt and tool definitions (about 5k tokens) leave too little room for the task.
const minimumContext = 16_384

async function ollamaContext(client: ReturnType<typeof Orbit.make>): Promise<Check[]> {
  const providers = await client.provider.list({ location: { directory: directory() } })
  const baseURL = providers.data.find((provider) => provider.id === "ollama")?.settings?.baseURL
  const origin = (typeof baseURL === "string" ? baseURL : "http://127.0.0.1:11434/v1").replace(/\/v1\/?$/, "")
  const running = await fetch(`${origin}/api/ps`)
    .then((response) => response.json() as Promise<{ models?: Array<{ name: string; context_length?: number }> }>)
    .catch(() => ({ models: [] }))
  return (running.models ?? []).map((item) => {
    if (!item.context_length)
      return { ok: undefined, label: "ollama context", detail: `${item.name}: not reported by this Ollama version` }
    if (item.context_length >= minimumContext)
      return { ok: true, label: "ollama context", detail: `${item.name}: ${item.context_length} tokens` }
    return {
      ok: false,
      label: "ollama context",
      detail: `${item.name}: ${item.context_length} tokens; Ollama silently drops older messages beyond this. Set OLLAMA_CONTEXT_LENGTH=32768 (or the app's Context length setting) and restart Ollama`,
    }
  })
}

// The model list is a snapshot that can precede plugin settlement (local providers are discovered over the network),
// so wait until the requested model appears, or until the list stops changing.
function names(list: readonly string[]) {
  return list.filter((name) => process.env[name] || process.env[name.toLowerCase()]).join(", ")
}

// Every label and detail is escaped here, at the sink: a PATH folder, a model ID, a provider error or a model name can
// hold control characters, and no check should have to remember to escape its own.
export function lines(checks: readonly Check[]) {
  const width = Math.max(...checks.map((check) => plain(check.label).length))
  return checks
    .map(
      (check) =>
        `${check.ok === undefined ? "  " : check.ok ? "ok" : "!!"} ${plain(check.label).padEnd(width)}  ${plain(check.detail)}${EOL}`,
    )
    .join("")
}

function print(checks: readonly Check[]) {
  process.stdout.write(lines(checks))
}

function finish(checks: readonly Check[]) {
  if (checks.some((check) => check.ok === false)) process.exitCode = 1
}
