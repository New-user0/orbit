import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Info } from "@orbit/schema/config"
import { AbsolutePath } from "@orbit/schema/schema"
import { CompatMcpJson } from "../src/mcp-json.js"
import { CompatNames } from "../src/names.js"
import { live } from "./fixture/effect.js"
import { services } from "./fixture/services.js"
import { tmpdirScoped, write } from "./fixture/tmpdir.js"

// The file a project keeps in its directory.
const fileIn = (directory: string) => AbsolutePath.make(path.join(directory, CompatNames.mcp))

// A project directory holding the file with `mcpServers`, read with `env` as the process environment. The servers come
// back in encoded form, as a server's own settings, so an expectation is the object a person would write in orbit.json.
const read = (mcpServers: unknown, env: Record<string, string | undefined> = {}) =>
  Effect.gen(function* () {
    const fixture = yield* tmpdirScoped()
    yield* write([[path.join(fixture, CompatNames.mcp), JSON.stringify({ mcpServers })]])
    const result = yield* CompatMcpJson.read({ file: fileIn(fixture), env }).pipe(
      Effect.provide(services(fixture, path.join(fixture, "home"))),
    )
    const document = result.documents[0]
    return {
      fixture,
      result,
      scope: document?.scope,
      servers: document === undefined ? undefined : Schema.encodeSync(Info)(document.info).mcp?.servers,
      messages: result.diagnostics.map((diagnostic) => `${diagnostic.path.join(".")}: ${diagnostic.message}`),
    }
  })

describe("CompatMcpJson.read", () => {
  live("maps a stdio server to a local server, with its arguments, variables and directory", () =>
    Effect.gen(function* () {
      const loaded = yield* read({
        files: {
          command: "npx",
          args: ["-y", "@example/files", "--root", "."],
          env: { LOG_LEVEL: "debug" },
          cwd: "tools",
        },
        plain: { type: "stdio", command: "./serve.sh" },
      })

      expect(loaded.servers).toEqual({
        files: {
          type: "local",
          command: ["npx", "-y", "@example/files", "--root", "."],
          environment: { LOG_LEVEL: "debug" },
          cwd: "tools",
        },
        plain: { type: "local", command: ["./serve.sh"] },
      })
      expect(loaded.messages).toEqual([])
    }),
  )

  live("maps http and sse servers to remote servers over the transport they name", () =>
    Effect.gen(function* () {
      const loaded = yield* read({
        docs: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer token" } },
        legacy: { type: "sse", url: "https://mcp.example.com/sse" },
      })

      expect(loaded.servers).toEqual({
        docs: {
          type: "remote",
          url: "https://mcp.example.com/mcp",
          transport: "streamable-http",
          headers: { Authorization: "Bearer token" },
        },
        legacy: { type: "remote", url: "https://mcp.example.com/sse", transport: "sse" },
      })
      expect(loaded.messages).toEqual([])
    }),
  )

  live("makes one project-scope document at the file, with servers the MCP service reads as they are", () =>
    Effect.gen(function* () {
      const loaded = yield* read({
        files: { command: "serve" },
        docs: { type: "http", url: "https://mcp.example.com" },
      })
      const document = loaded.result.documents[0]

      expect(loaded.result.documents).toHaveLength(1)
      expect(document.scope).toBe("project")
      expect(document.path).toBe(fileIn(loaded.fixture))
      expect(document.info.mcp?.servers?.files?.type).toBe("local")
      expect(document.info.mcp?.servers?.docs?.type).toBe("remote")
      // Only the servers come through: no setting that would change anything else.
      expect(Object.keys(Schema.encodeSync(Info)(document.info))).toEqual(["mcp"])
    }),
  )

  live("expands ${NAME} and ${NAME:-fallback} from the environment in every field that holds a string", () =>
    Effect.gen(function* () {
      const loaded = yield* read(
        {
          files: {
            command: "${TOOLS}/serve",
            args: ["--token", "${TOKEN}", "--mode=${MODE:-dev}", "${EMPTY:-none}", "${UNSET:-}"],
            env: { API_URL: "${BASE:-https://api.example.com}/v1", PLAIN: "no references", EMPTY_VALUE: "${EMPTY}" },
            cwd: "${HOME_DIR}/work",
          },
          docs: {
            type: "http",
            url: "${SCHEME:-https}://${HOST}/mcp",
            headers: { Authorization: "Bearer ${TOKEN}", "X-Mode": "${MODE:-dev}" },
          },
        },
        { TOOLS: "/opt/tools", TOKEN: "t0k3n", EMPTY: "", HOME_DIR: "/home/person", HOST: "mcp.example.com" },
      )

      expect(loaded.servers).toEqual({
        files: {
          type: "local",
          command: ["/opt/tools/serve", "--token", "t0k3n", "--mode=dev", "none", ""],
          environment: { API_URL: "https://api.example.com/v1", PLAIN: "no references", EMPTY_VALUE: "" },
          cwd: "/home/person/work",
        },
        docs: {
          type: "remote",
          url: "https://mcp.example.com/mcp",
          transport: "streamable-http",
          headers: { Authorization: "Bearer t0k3n", "X-Mode": "dev" },
        },
      })
      expect(loaded.messages).toEqual([])
    }),
  )

  live("prefers a variable that is set to the fallback, and leaves text that is not a reference alone", () =>
    Effect.gen(function* () {
      const loaded = yield* read(
        { files: { command: "serve", args: ["${MODE:-dev}", "$MODE", "${1}", "${ }", "$${MODE}", "{MODE}"] } },
        { MODE: "prod" },
      )

      // A `$` before a reference is not an escape: what follows it still expands.
      expect(loaded.servers).toEqual({
        files: { type: "local", command: ["serve", "prod", "$MODE", "${1}", "${ }", "$prod", "{MODE}"] },
      })
    }),
  )

  live("skips a server that names an unset variable with no fallback, and never reports a value", () =>
    Effect.gen(function* () {
      const loaded = yield* read(
        {
          kept: { command: "serve", env: { TOKEN: "${TOKEN}" } },
          localGap: { command: "serve", args: ["${MISSING_ARG}"], env: { A: "${MISSING_ENV}", B: "${MISSING_ARG}" } },
          remoteGap: { type: "http", url: "https://${HOST}/mcp", headers: { Authorization: "Bearer ${MISSING_KEY}" } },
        },
        { TOKEN: "super-secret-value" },
      )

      expect(Object.keys(loaded.servers ?? {})).toEqual(["kept"])
      expect(loaded.messages).toEqual([
        "mcpServers.localGap: skipped server that refers to unset environment variables: MISSING_ARG, MISSING_ENV",
        "mcpServers.remoteGap: skipped server that refers to unset environment variables: HOST, MISSING_KEY",
      ])
      // A reference to a variable that is set is no reason to skip, and no value is ever put in a message.
      expect(JSON.stringify(loaded.result.diagnostics)).not.toContain("super-secret-value")
    }),
  )

  live("ignores a variable that only a field the server does not use refers to", () =>
    Effect.gen(function* () {
      const loaded = yield* read({
        // A stdio server has no url or headers, and a remote one has no command or arguments.
        files: { command: "serve", url: "https://${NOT_USED}", headers: { A: "${NOT_USED}" } },
        docs: { type: "http", url: "https://mcp.example.com", command: "${NOT_USED}", args: ["${NOT_USED}"] },
      })

      expect(Object.keys(loaded.servers ?? {})).toEqual(["files", "docs"])
      expect(loaded.messages).toEqual([])
    }),
  )

  live("skips a server that cannot be mapped, with a diagnostic, and keeps the others", () =>
    Effect.gen(function* () {
      const loaded = yield* read({
        kept: { command: "serve" },
        noCommand: { args: ["-y"] },
        emptyCommand: { command: "" },
        noUrl: { type: "http" },
        emptyUrl: { type: "sse", url: "" },
        unknownType: { type: "websocket", url: "wss://mcp.example.com" },
        badArgs: { command: "serve", args: "-y" },
        badArgItem: { command: "serve", args: ["-y", 1] },
        badEnv: { command: "serve", env: { A: 1 } },
        badHeaders: { type: "http", url: "https://mcp.example.com", headers: ["x"] },
        notAnObject: "serve",
        nothing: null,
      })

      expect(Object.keys(loaded.servers ?? {})).toEqual(["kept"])
      expect(loaded.result.diagnostics.map((diagnostic) => [diagnostic.path.join("."), diagnostic.kind])).toEqual([
        ["mcpServers.noCommand", "invalid"],
        ["mcpServers.emptyCommand", "invalid"],
        ["mcpServers.noUrl", "invalid"],
        ["mcpServers.emptyUrl", "invalid"],
        ["mcpServers.unknownType", "unsupported"],
        ["mcpServers.badArgs", "invalid"],
        ["mcpServers.badArgItem", "invalid"],
        ["mcpServers.badEnv", "invalid"],
        ["mcpServers.badHeaders", "invalid"],
        ["mcpServers.notAnObject", "invalid"],
        ["mcpServers.nothing", "invalid"],
      ])
      expect(loaded.messages.slice(0, 5)).toEqual([
        "mcpServers.noCommand: skipped server without a command",
        "mcpServers.emptyCommand: skipped server without a command",
        "mcpServers.noUrl: skipped server without a url",
        "mcpServers.emptyUrl: skipped server without a url",
        "mcpServers.unknownType: omitted server of an unknown type",
      ])
      expect(
        loaded.result.diagnostics.every((diagnostic) => diagnostic.source === path.join(loaded.fixture, ".mcp.json")),
      ).toBe(true)
    }),
  )

  live("makes no document when no server can be mapped", () =>
    Effect.gen(function* () {
      const loaded = yield* read({ noCommand: {}, unknownType: { type: "websocket" } })

      expect(loaded.result.documents).toEqual([])
      expect(loaded.result.diagnostics).toHaveLength(2)
      expect((yield* read({})).result).toEqual({ documents: [], diagnostics: [] })
    }),
  )

  live("ignores the fields it does not map, and a server's own name keeps its spelling", () =>
    Effect.gen(function* () {
      const loaded = yield* read({
        "Weird name.v2": { command: "serve", alwaysLoad: true, timeout: 5, disabled: true },
      })

      expect(loaded.servers).toEqual({ "Weird name.v2": { type: "local", command: ["serve"] } })
      expect(loaded.messages).toEqual([])
    }),
  )

  live("ignores a file that has no servers, is not JSON, is not an object or holds servers that are not one", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const file = path.join(fixture, CompatNames.mcp)
      const read = (text: string) =>
        write([[file, text]]).pipe(
          Effect.andThen(
            CompatMcpJson.read({ file: fileIn(fixture), env: {} }).pipe(
              Effect.provide(services(fixture, path.join(fixture, "home"))),
            ),
          ),
        )

      expect(yield* read("{}")).toEqual({ documents: [], diagnostics: [] })
      expect(yield* read(JSON.stringify({ servers: { files: { command: "serve" } } }))).toEqual({
        documents: [],
        diagnostics: [],
      })
      for (const text of ["{ not json", "[]", "null", ""]) {
        const result = yield* read(text)
        expect(result.documents).toEqual([])
        expect(result.diagnostics).toEqual([
          { source: file, kind: "invalid", path: ["$"], message: "rejected malformed JSON document" },
        ])
      }
      for (const servers of [[], "files", 1, null]) {
        const result = yield* read(JSON.stringify({ mcpServers: servers }))
        expect(result.documents).toEqual([])
        expect(result.diagnostics).toEqual([
          { source: file, kind: "invalid", path: ["mcpServers"], message: "skipped malformed recognized value" },
        ])
      }
    }),
  )

  live("makes nothing when the file does not exist, or is a directory", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const run = CompatMcpJson.read({ file: fileIn(fixture), env: {} }).pipe(
        Effect.provide(services(fixture, path.join(fixture, "home"))),
      )

      expect(yield* run).toEqual({ documents: [], diagnostics: [] })
      yield* write([path.join(fixture, CompatNames.mcp)])
      expect(yield* run).toEqual({ documents: [], diagnostics: [] })
    }),
  )
})
