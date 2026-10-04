import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Info, type Document } from "@orbit/schema/config"
import { AbsolutePath } from "@orbit/schema/schema"
import { CompatNames } from "../src/names.js"
import type { CompatRoots } from "../src/roots.js"
import { CompatSettings } from "../src/settings.js"
import { live } from "./fixture/effect.js"
import { services } from "./fixture/services.js"
import { tmpdirScoped, write } from "./fixture/tmpdir.js"

const shared = CompatNames.vendor.settings.shared
const local = CompatNames.vendor.settings.local

const root = (directory: string, scope: CompatRoots.Root["scope"], kind: CompatRoots.Kind = "vendor") =>
  ({ path: AbsolutePath.make(directory), kind, scope }) satisfies CompatRoots.Root

const read = (fixture: string, roots: readonly CompatRoots.Root[]) =>
  CompatSettings.read(roots).pipe(Effect.provide(services(fixture, path.join(fixture, "home"))))

const guard = (command: string, matcher = "Bash") => ({ matcher, hooks: [{ type: "command", command }] })
const settings = (hooks: unknown) => JSON.stringify({ hooks })

// A document as `scope:file:matcher:command` lines, with the file relative to the fixture so that expectations read
// without the temporary directory.
const labels = (fixture: string, documents: readonly Document[]) =>
  documents.flatMap((document) =>
    (document.info.hooks?.PreToolUse ?? []).flatMap((group) =>
      group.hooks.map((hook) => {
        const file = path
          .relative(fixture, document.path ?? "")
          .split(path.sep)
          .join("/")
        return `${document.scope}:${file}:${group.matcher}:${hook.type === "command" ? hook.command : hook.type}`
      }),
    ),
  )

describe("CompatSettings.files", () => {
  test("lists each vendor root's shared file and then its local file, with the scope each ranks in", () => {
    const user = root(path.resolve("home", CompatNames.vendor.directory), "user")
    const project = root(path.resolve("repo", CompatNames.vendor.directory), "project")

    expect(CompatSettings.files([user, project]).map((file) => [String(file.path), file.scope])).toEqual([
      [path.join(user.path, shared), "user"],
      // The user's local file has no outer tier above it, so it stays with the rest of their settings.
      [path.join(user.path, local), "user"],
      [path.join(project.path, shared), "project"],
      [path.join(project.path, local), "local"],
    ])
  })

  test("skips the roots of the other kinds", () => {
    expect(CompatSettings.files([root(path.resolve(CompatNames.agents), "project", "agents")])).toEqual([])
    expect(CompatSettings.files([])).toEqual([])
  })
})

describe("CompatSettings.read", () => {
  live("reads hooks at user, project and local scope, shared files before local ones", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const home = path.join(fixture, "home", CompatNames.vendor.directory)
      const repo = path.join(fixture, "repo", CompatNames.vendor.directory)
      const app = path.join(fixture, "repo", "app", CompatNames.vendor.directory)
      yield* write([
        [path.join(home, shared), settings({ PreToolUse: [guard("user-shared")] })],
        [path.join(home, local), settings({ PreToolUse: [guard("user-local")] })],
        [path.join(repo, shared), settings({ PreToolUse: [guard("repo-shared")] })],
        [path.join(repo, local), settings({ PreToolUse: [guard("repo-local")] })],
        [path.join(app, shared), settings({ PreToolUse: [guard("app-shared")] })],
      ])

      const result = yield* read(fixture, [root(home, "user"), root(repo, "project"), root(app, "project")])

      // Lowest priority first, in the order the roots were given. A document's scope is the rank its file gets.
      expect(labels(fixture, result.documents)).toEqual([
        "user:home/.claude/settings.json:Bash:user-shared",
        "user:home/.claude/settings.local.json:Bash:user-local",
        "project:repo/.claude/settings.json:Bash:repo-shared",
        "local:repo/.claude/settings.local.json:Bash:repo-local",
        "project:repo/app/.claude/settings.json:Bash:app-shared",
      ])
      expect(result.diagnostics).toEqual([])
    }),
  )

  live("keeps the file's path on its document, and only what Orbit can use of the file", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const directory = path.join(fixture, CompatNames.vendor.directory)
      yield* write([
        [
          path.join(directory, shared),
          JSON.stringify({
            model: "other-model",
            env: { TOKEN: "secret" },
            hooks: { PreToolUse: [guard("./check.sh")] },
          }),
        ],
      ])

      const result = yield* read(fixture, [root(directory, "project")])

      expect(result.documents.map((document) => String(document.path))).toEqual([path.join(directory, shared)])
      // Nothing but the hooks reaches the configuration.
      expect(Schema.encodeSync(Info)(result.documents[0].info)).toEqual({
        hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./check.sh" }] }] },
      })
    }),
  )

  live("ignores a root of any other kind", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const directory = path.join(fixture, CompatNames.agents)
      yield* write([[path.join(directory, shared), settings({ PreToolUse: [guard("from-agents")] })]])

      expect((yield* read(fixture, [root(directory, "project", "agents")])).documents).toEqual([])
    }),
  )

  live("skips a file that is missing, or that is not a file, without a word", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const empty = path.join(fixture, "empty", CompatNames.vendor.directory)
      const odd = path.join(fixture, "odd", CompatNames.vendor.directory)
      // A directory where the settings file belongs cannot be read as one.
      yield* write([empty, path.join(odd, shared)])

      const result = yield* read(fixture, [root(empty, "project"), root(odd, "project")])

      expect(result).toEqual({ documents: [], diagnostics: [] })
    }),
  )

  live("ignores a file that is not JSON, and says so", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const directory = path.join(fixture, CompatNames.vendor.directory)
      yield* write([
        [path.join(directory, shared), "{ not json"],
        [path.join(directory, local), settings({ PreToolUse: [guard("./still-read.sh")] })],
      ])

      const result = yield* read(fixture, [root(directory, "project")])

      // One bad file never costs the file beside it.
      expect(labels(fixture, result.documents)).toEqual(["local:.claude/settings.local.json:Bash:./still-read.sh"])
      expect(result.diagnostics).toEqual([
        {
          source: path.join(directory, shared),
          kind: "invalid",
          path: ["$"],
          message: "rejected malformed JSON document",
        },
      ])
    }),
  )

  live("ignores a file that is JSON but not an object", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const directory = path.join(fixture, CompatNames.vendor.directory)
      yield* write([
        [path.join(directory, shared), "[]"],
        [path.join(directory, local), "null"],
      ])

      const result = yield* read(fixture, [root(directory, "project")])

      expect(result.documents).toEqual([])
      expect(result.diagnostics.map((diagnostic) => [path.basename(diagnostic.source), diagnostic.kind])).toEqual([
        [shared, "invalid"],
        [local, "invalid"],
      ])
    }),
  )

  live("makes no document for a file with no hooks, or with hooks that do nothing", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const directory = path.join(fixture, CompatNames.vendor.directory)
      yield* write([
        [
          path.join(directory, shared),
          JSON.stringify({ model: "other-model", permissions: { allow: ["Bash(ls:*)"] } }),
        ],
        [path.join(directory, local), settings({})],
      ])

      expect(yield* read(fixture, [root(directory, "project")])).toEqual({ documents: [], diagnostics: [] })
    }),
  )

  live("costs a hook that cannot be read only itself, and reports it at its path in the file", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const directory = path.join(fixture, CompatNames.vendor.directory)
      // The file mixes a guard with a hook this version rejects (a model needs its provider), and the local file is
      // not a hooks object at all.
      yield* write([
        [
          path.join(directory, shared),
          settings({
            PreToolUse: [guard("echo 'guard fired' >&2; exit 2")],
            SubagentStop: [{ hooks: [{ type: "prompt", prompt: "Did it finish?", model: "fast-model" }] }],
          }),
        ],
        [path.join(directory, local), settings("off")],
      ])

      const result = yield* read(fixture, [root(directory, "project")])

      expect(labels(fixture, result.documents)).toEqual([
        "project:.claude/settings.json:Bash:echo 'guard fired' >&2; exit 2",
      ])
      expect(result.diagnostics).toEqual([
        {
          source: path.join(directory, shared),
          kind: "invalid",
          path: ["hooks", "SubagentStop", "0", "hooks", "0"],
          message: "skipped malformed recognized value",
        },
        {
          source: path.join(directory, local),
          kind: "invalid",
          path: ["hooks"],
          message: "skipped malformed recognized value",
        },
      ])
    }),
  )

  live("reports an unusable permissions block without costing the hooks beside it", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const directory = path.join(fixture, CompatNames.vendor.directory)
      yield* write([
        [
          path.join(directory, shared),
          JSON.stringify({ permissions: { allow: "Bash" }, hooks: { PreToolUse: [guard("./guard.sh")] } }),
        ],
      ])

      const result = yield* read(fixture, [root(directory, "project")])

      expect(labels(fixture, result.documents)).toEqual(["project:.claude/settings.json:Bash:./guard.sh"])
      expect(result.diagnostics).toEqual([
        {
          source: path.join(directory, shared),
          kind: "invalid",
          path: ["permissions"],
          message: "skipped malformed recognized value",
        },
      ])
    }),
  )

  live("reads a hooks file written with a policy only", () =>
    Effect.gen(function* () {
      const fixture = yield* tmpdirScoped()
      const directory = path.join(fixture, CompatNames.vendor.directory)
      yield* write([[path.join(directory, shared), settings({ disabled: true })]])

      const result = yield* read(fixture, [root(directory, "project")])

      expect(result.documents.map((document) => document.info.hooks?.disabled)).toEqual([true])
    }),
  )
})

describe("CompatSettings.isForeign", () => {
  const directory = CompatNames.vendor.directory

  test("recognizes the settings files that read loads, whatever directory holds the vendor root", () => {
    for (const parent of ["/home/person", "/work/repo", "/work/repo/packages/app"])
      for (const name of [shared, local])
        expect(CompatSettings.isForeign(path.resolve(parent, directory, name))).toBe(true)
  })

  test("is false for Orbit's own files, other files of the vendor root, and a path that is not there", () => {
    expect(CompatSettings.isForeign(path.resolve("repo", "orbit.json"))).toBe(false)
    expect(CompatSettings.isForeign(path.resolve("repo", ".orbit", "orbit.json"))).toBe(false)
    // Another directory's settings file, and the vendor directory's other files, are not read as settings.
    expect(CompatSettings.isForeign(path.resolve("repo", shared))).toBe(false)
    expect(CompatSettings.isForeign(path.resolve("repo", CompatNames.agents, shared))).toBe(false)
    expect(CompatSettings.isForeign(path.resolve("repo", directory, "skills", shared))).toBe(false)
    expect(CompatSettings.isForeign(path.resolve("repo", directory, "other.json"))).toBe(false)
    expect(CompatSettings.isForeign(undefined)).toBe(false)
  })
})

describe("CompatSettings permissions", () => {
  test("decode typed allow, deny and ask lists, each optional", () => {
    const decode = Schema.decodeUnknownSync(CompatSettings.ForeignPermissions)

    expect(decode({ allow: ["Bash(git status)"], deny: ["Read(.env)"], ask: ["Edit"] })).toEqual({
      allow: ["Bash(git status)"],
      deny: ["Read(.env)"],
      ask: ["Edit"],
    })
    expect(decode({ ask: [] })).toEqual({ ask: [] })
    expect(decode({ defaultMode: "plan", allow: ["Bash"] })).toEqual({ allow: ["Bash"] })
    expect(() => decode({ allow: "Bash" })).toThrow()
    expect(() => decode({ deny: [1] })).toThrow()
  })

  test("translate to nothing until the permissions work fills the translation in", () => {
    expect(CompatSettings.translatePermissions({ allow: ["Bash(ls:*)"], deny: ["Read(.env)"], ask: ["Edit"] })).toEqual(
      [],
    )
    expect(CompatSettings.translatePermissions({})).toEqual([])
  })
})
