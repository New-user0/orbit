import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Info } from "@orbit/schema/config"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Fingerprint } from "@orbit/core/config/fingerprint"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { FSUtil } from "@orbit/util/fs-util"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node])))
const decode = Schema.decodeUnknownSync(Info)

const hook = (command: string) => ({ PreToolUse: [{ matcher: "shell", hooks: [{ type: "command", command }] }] })

// One config for each digested kind, written in a different key order each time it is asked for.
const fields = {
  hooks: hook("echo one"),
  mcp: { servers: { docs: { type: "local", command: ["docs-server"] } } },
  plugins: ["./local-plugin"],
  providers: { acme: { name: "Acme" } },
  shell: "bash",
  formatter: { fmt: { command: ["fmt", "$FILE"] } },
  lsp: { ts: { command: ["tsserver"] } },
  env: { A: "1", B: "2" },
  sandbox: { enabled: true },
  skills: ["./skills-elsewhere"],
} as const

const changed = {
  hooks: hook("echo two"),
  mcp: { servers: { docs: { type: "local", command: ["other-server"] } } },
  plugins: ["./other-plugin"],
  providers: { acme: { name: "Other" } },
  shell: "zsh",
  formatter: { fmt: { command: ["fmt2", "$FILE"] } },
  lsp: { ts: { command: ["tsserver2"] } },
  env: { A: "1", B: "3" },
  sandbox: { enabled: false },
  skills: ["./elsewhere-too"],
} as const

const digestsOf = (value: Record<string, unknown>) =>
  Effect.gen(function* () {
    const files = yield* FSUtil.Service
    return yield* Fingerprint.document(files, "orbit.json", decode(value), [], [])
  })

describe("Fingerprint.document", () => {
  it.live("gives one digest to each kind that is set, and none to a kind that is not", () =>
    Effect.gen(function* () {
      expect(Object.keys(yield* digestsOf(fields)).sort()).toEqual(Object.keys(fields).sort())
      expect(yield* digestsOf({})).toEqual({})
      expect(Object.keys(yield* digestsOf({ shell: "bash" }))).toEqual(["shell"])
    }),
  )

  it.live("does not see the order of keys or the formatting of the file it came from", () =>
    Effect.gen(function* () {
      const reordered = {
        skills: fields.skills,
        sandbox: { enabled: true },
        env: { B: "2", A: "1" },
        lsp: fields.lsp,
        formatter: { fmt: { command: ["fmt", "$FILE"] } },
        shell: "bash",
        providers: fields.providers,
        plugins: fields.plugins,
        mcp: { servers: { docs: { command: ["docs-server"], type: "local" } } },
        hooks: { PreToolUse: [{ hooks: [{ command: "echo one", type: "command" }], matcher: "shell" }] },
      }
      expect(yield* digestsOf(reordered)).toEqual(yield* digestsOf(fields))
      // Comments, indentation and line endings are gone once the file is read into a document.
      const text = `{\r\n  // a comment\r\n  "shell": "bash",\r\n  "env": {"A": "1"}\r\n}\r\n`
      const compact = `{"env":{"A":"1"},"shell":"bash"}`
      const { parse } = yield* Effect.promise(() => import("jsonc-parser"))
      expect(yield* digestsOf(parse(text))).toEqual(yield* digestsOf(parse(compact)))
    }),
  )

  it.live("sees no change in what runs no program: a model, permissions or a grant", () =>
    Effect.gen(function* () {
      const base = yield* digestsOf({ shell: "bash" })
      const edited = yield* digestsOf({
        shell: "bash",
        model: "acme/big",
        username: "someone",
        permissions: [{ action: "shell", resource: "*", effect: "allow" }],
        commands: { deploy: { template: "echo !`rm -rf /`" } },
      })
      expect(edited).toEqual(base)
    }),
  )

  for (const kind of Object.keys(fields) as (keyof typeof fields)[]) {
    it.live(`changes only ${kind} when ${kind} is edited`, () =>
      Effect.gen(function* () {
        const before = yield* digestsOf(fields)
        const after = yield* digestsOf({ ...fields, [kind]: changed[kind] })
        const differing = Object.keys(before).filter((name) => before[name as keyof typeof before] !== after[name as keyof typeof after])
        expect(differing).toEqual([kind])
      }),
    )
  }

  it.live("covers the hooks in the front matter of the skills a document points at, under skills", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const root = (yield* tmpdirScoped()).path
      const skills = path.join(root, "my-skills")
      yield* Effect.promise(() => fs.mkdir(path.join(skills, "demo"), { recursive: true }))
      const skill = path.join(skills, "demo", "SKILL.md")
      const digests = (hooks: string) =>
        Effect.promise(() =>
          fs.writeFile(skill, `---\nname: demo\ndescription: d\nhooks:\n  PreToolUse:\n    - command: ${hooks}\n---\nbody\n`),
        ).pipe(Effect.andThen(Fingerprint.document(files, "orbit.json", decode({ skills: [skills] }), [skills], [root])))
      const first = yield* digests("echo a")
      expect(yield* digests("echo a")).toEqual(first)
      const second = yield* digests("echo b")
      expect(second.skills).not.toEqual(first.skills)
      // Only the skills digest of the document moved.
      expect(Object.keys(second)).toEqual(["skills"])
    }),
  )
})

describe("Fingerprint.directory", () => {
  const plugin = (root: string, name: string, text: string) =>
    Effect.promise(async () => {
      await fs.mkdir(path.join(root, "plugins"), { recursive: true })
      await fs.writeFile(path.join(root, "plugins", name), text)
    })

  it.live("has no digest for a directory that holds nothing executable", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const root = (yield* tmpdirScoped()).path
      yield* Effect.promise(() => fs.mkdir(path.join(root, ".orbit"), { recursive: true }))
      expect(yield* Fingerprint.directory(files, path.join(root, ".orbit"))).toEqual({})
    }),
  )

  it.live("changes plugins when a plugin is added or its entry file or package.json is edited", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const folder = path.join((yield* tmpdirScoped()).path, ".orbit")
      yield* Effect.promise(() => fs.mkdir(folder, { recursive: true }))
      yield* plugin(folder, "greeter.ts", "export default 1\n")
      const first = yield* Fingerprint.directory(files, folder)
      expect(Object.keys(first)).toEqual(["plugins"])

      yield* plugin(folder, "second.ts", "export default 2\n")
      const added = yield* Fingerprint.directory(files, folder)
      expect(added.plugins).not.toBe(first.plugins)

      yield* plugin(folder, "greeter.ts", "export default 3\n")
      const edited = yield* Fingerprint.directory(files, folder)
      expect(edited.plugins).not.toBe(added.plugins)

      yield* Effect.promise(() =>
        fs.mkdir(path.join(folder, "plugins", "pkg"), { recursive: true }).then(() =>
          fs.writeFile(path.join(folder, "plugins", "pkg", "index.ts"), "export default 4\n"),
        ),
      )
      const withPackage = yield* Fingerprint.directory(files, folder)
      yield* Effect.promise(() =>
        fs.writeFile(path.join(folder, "plugins", "pkg", "package.json"), JSON.stringify({ name: "pkg", main: "index.ts" })),
      )
      const manifest = yield* Fingerprint.directory(files, folder)
      expect(manifest.plugins).not.toBe(withPackage.plugins)
    }),
  )

  it.live("reads content, not the modification time: a touch is no change and an edit with the old time is", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const folder = path.join((yield* tmpdirScoped()).path, ".orbit")
      yield* Effect.promise(() => fs.mkdir(folder, { recursive: true }))
      yield* plugin(folder, "greeter.ts", "export default 1\n")
      const file = path.join(folder, "plugins", "greeter.ts")
      const before = yield* Fingerprint.directory(files, folder)
      const stamp = (yield* Effect.promise(() => fs.stat(file))).mtime

      yield* Effect.promise(() => fs.utimes(file, new Date(), new Date(Date.now() + 5000)))
      expect(yield* Fingerprint.directory(files, folder)).toEqual(before)

      yield* plugin(folder, "greeter.ts", "export default 9\n")
      yield* Effect.promise(() => fs.utimes(file, stamp, stamp))
      expect((yield* Fingerprint.directory(files, folder)).plugins).not.toBe(before.plugins)
    }),
  )

  it.live("changes hooks when a skill or an agent gains front matter hooks, and mcp for an agent's servers", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const folder = path.join((yield* tmpdirScoped()).path, ".orbit")
      yield* Effect.promise(() => fs.mkdir(path.join(folder, "skills", "x"), { recursive: true }))
      yield* Effect.promise(() => fs.mkdir(path.join(folder, "agents"), { recursive: true }))
      // Text only: nothing to digest.
      yield* Effect.promise(() => fs.writeFile(path.join(folder, "skills", "x", "SKILL.md"), "---\nname: x\ndescription: d\n---\nbody\n"))
      expect(yield* Fingerprint.directory(files, folder)).toEqual({})

      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(folder, "skills", "x", "SKILL.md"),
          "---\nname: x\ndescription: d\nhooks:\n  PreToolUse:\n    - command: echo hi\n---\nbody\n",
        ),
      )
      const skill = yield* Fingerprint.directory(files, folder)
      expect(Object.keys(skill)).toEqual(["hooks"])

      yield* Effect.promise(() =>
        fs.writeFile(
          path.join(folder, "agents", "ops.md"),
          "---\ndescription: ops\nmcp_servers:\n  docs:\n    command: docs-server\n---\nprompt\n",
        ),
      )
      const agent = yield* Fingerprint.directory(files, folder)
      expect(Object.keys(agent).sort()).toEqual(["hooks", "mcp"])
      // The agent's servers moved mcp only, and the skill's hooks did not move.
      expect(agent.hooks).toBe(skill.hooks)

      yield* Effect.promise(() =>
        fs.writeFile(path.join(folder, "agents", "ops.md"), "---\ndescription: ops\nhooks:\n  Stop:\n    - command: echo bye\n---\nprompt\n"),
      )
      const hooked = yield* Fingerprint.directory(files, folder)
      expect(hooked.hooks).not.toBe(skill.hooks)
      expect(hooked.mcp).toBeUndefined()
    }),
  )

  it.live("counts a file it cannot read as changed for that kind of that source only", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const folder = path.join((yield* tmpdirScoped()).path, ".orbit")
      yield* Effect.promise(() => fs.mkdir(path.join(folder, "skills", "x"), { recursive: true }))
      yield* plugin(folder, "greeter.ts", "export default 1\n")
      const bad = path.join(folder, "skills", "x", "SKILL.md")
      yield* Effect.promise(() => fs.writeFile(bad, "---\nname: x\ndescription: d\nhooks: {}\n---\n"))
      // A file system whose read of one file fails, as a locked file does.
      const locked: FSUtil.Interface = {
        ...files,
        readFileString: (file, ...rest) =>
          file === bad ? Effect.die(new Error("locked")) : files.readFileString(file, ...rest),
      }
      const found = yield* Fingerprint.directory(locked, folder)
      expect(found.hooks).toBe(WorkspaceTrust.unreadable)
      expect(found.mcp).toBe(WorkspaceTrust.unreadable)
      // The plugins of the same directory are digested as usual.
      expect(found.plugins).toMatch(/^[0-9a-f]{64}$/)
    }),
  )
})
