import { describe, expect } from "bun:test"
import fs from "fs"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer } from "effect"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { FileAccess } from "@orbit/core/file-access"
import { Instance } from "@orbit/core/instance/service"
import { Location } from "@orbit/core/location"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { Permission } from "@orbit/core/permission"
import { PermissionPolicy } from "@orbit/core/permission/policy"
import { PermissionSaved } from "@orbit/core/permission/saved"
import { Plugin } from "@orbit/core/plugin"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { Project } from "@orbit/core/project"
import { ProjectTable } from "@orbit/core/project/sql"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionPrompt } from "@orbit/core/session/prompt"
import { SessionTable } from "@orbit/core/session/sql"
import { SessionStore } from "@orbit/core/session/store"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { location } from "./fixture/location"
import { installPolicy } from "./fixture/policy"
import { untrustedProjectNodes } from "./fixture/project-trust"
import { canLinkFile } from "./fixture/symlink"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

// Admission decides what of a prompt's editor field and @agent mentions reaches the durable inbox item. The real stack
// decides: Permission, Agent and FileAccess; only the instance is a pass-through, because the stack is already the
// session's own.

const sessionID = Session.ID.make("ses_prompt_editor")

// `project` is the session folder; `worktree` is the project's, when the session folder is below it.
const provide = (project: string, trusted = true, worktree = project) =>
  Effect.provide(
    Layer.mergeAll(
      AppNodeBuilder.build(
        LayerNode.group([
          Database.node,
          Bus.node,
          SessionStore.node,
          PermissionSaved.node,
          Agent.node,
          PluginHooks.node,
          ManagedPolicy.node,
          Permission.node,

          PermissionPolicy.node,
          Global.node,
          FileAccess.node,
          ProjectTrust.node,
          FSUtil.node,
        ]),
        [
          ...(trusted ? [] : untrustedProjectNodes),
          Location.node.replace(
            Layer.succeed(
              Location.Service,
              Location.Service.of(
                location({ directory: AbsolutePath.make(project) }, { projectDirectory: AbsolutePath.make(worktree) }),
              ),
            ),
          ),
        ],
      ),
      Layer.mock(Plugin.Service, { awaitActivation: Effect.void }),
      Layer.succeed(Instance.Service, Instance.Service.of({ provide: () => (effect) => effect as never })),
    ),
  )

const prepare = (project: string, rules: Permission.Ruleset, worktree = project) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make(worktree), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "editor",
        directory: project,
        title: "editor",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const agents = yield* Agent.Service
    yield* agents.transform((editor) => {
      editor.update(Agent.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      })
      editor.update(Agent.ID.make("helper"), (agent) => {
        agent.mode = "subagent"
      })
      editor.update(Agent.ID.make("both"), (agent) => {
        agent.mode = "all"
      })
      editor.update(Agent.ID.make("lead"), (agent) => {
        agent.mode = "primary"
      })
    })
  })

/** Admits one prompt the way `Session.prompt` does and returns the inbox payload. */
const admit = (input: SessionPrompt.Input) =>
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const session = yield* store.get(sessionID)
    if (!session) throw new Error("no session")
    const item = yield* SessionPrompt.prepare({ session, messageID: SessionMessage.ID.create(), input }).pipe(
      Effect.provideService(FSUtil.Service, yield* FSUtil.Service),
    )
    if (item.type !== "user") throw new Error("not a user item")
    return item.payload
  })

const allow = { action: "*", resource: "*", effect: "allow" } satisfies Permission.Rule

describe("editor context at admission", () => {
  it.live("passes through onto the inbox payload", () =>
    Effect.gen(function* () {
      const project = (yield* tmpdirScoped()).path
      const editor = {
        path: path.join(project, "src", "a.ts"),
        selection: { start: 2, end: 4, text: "one\ntwo\nthree" },
      }
      const payload = yield* Effect.gen(function* () {
        yield* prepare(project, [allow])
        return yield* admit({ text: "hi", editor })
      }).pipe(provide(project))
      expect(payload.editor).toEqual(editor)
    }),
  )

  const spellings = (project: string) =>
    [
      ["plain path", path.join(project, "secret", "key.txt")],
      ...(process.platform === "win32"
        ? [["other drive-letter case", path.join(project, "secret", "key.txt").replace(/^./, (c) => c.toLowerCase())] as const]
        : []),
    ] as const

  it.live("a read rule that denies the path drops the field and still admits the prompt", () =>
    Effect.gen(function* () {
      const project = (yield* tmpdirScoped()).path
      const results = yield* Effect.gen(function* () {
        yield* prepare(project, [allow, { action: "Read", resource: "secret/*", effect: "deny" }])
        return yield* Effect.forEach(
          [...spellings(project), ["trusted control", path.join(project, "open", "a.txt")] as const],
          ([name, file]) =>
            Effect.gen(function* () {
              const payload = yield* admit({ text: "hi", editor: { path: file } })
              return [name, payload.text, payload.editor !== undefined] as const
            }),
        )
      }).pipe(provide(project))
      expect(results).toEqual([
        ["plain path", "hi", false],
        ...(process.platform === "win32" ? [["other drive-letter case", "hi", false] as const] : []),
        ["trusted control", "hi", true],
      ])
    }),
  )

  // The class matrix of the editor path: every spelling of the denied file, then of the home folder. A row is kept (true)
  // only when the rule does not cover it. The last column says why a dropped row is dropped: "deny" rows are kept by an
  // allow-only control run, "refused" rows are refused by the resolver whatever the rules say, and "relative" rows are
  // not absolute for the platform the resolver runs on.
  const matrix = (project: string) => {
    const secret = path.join(project, "secret", "key.txt")
    const posix = (value: string) => value.replaceAll("\\", "/")
    const drive = secret[0].toLowerCase()
    const windowsOnly = process.platform === "win32"
    fs.mkdirSync(path.join(project, "secret"), { recursive: true })
    fs.mkdirSync(path.join(project, "open"), { recursive: true })
    if (windowsOnly) fs.symlinkSync(path.join(project, "secret"), path.join(project, "open", "link"), "junction")
    type Row = readonly [name: string, file: string, kept: boolean, why: "deny" | "refused" | "relative"]
    const common: ReadonlyArray<Row> = [
      ["plain path", secret, false, "deny"],
      ["dot-dot segments", path.join(project, "open", "..", "secret", "key.txt"), false, "deny"],
      ["trusted control", path.join(project, "open", "a.txt"), true, "deny"],
      ["~/ home spelling", "~/.ssh/id_rsa", false, "deny"],
      ["~/ home spelling, allowed file", "~/notes/a.txt", true, "deny"],
      ["~name is a relative path", "~root/.ssh/id_rsa", false, "relative"],
      ["~name with a backslash", "~root\\.ssh\\id_rsa", false, "relative"],
    ]
    const windows: ReadonlyArray<Row> = [
      ["forward slashes", posix(secret), false, "deny"],
      ["upper-case folder", secret.toUpperCase(), false, "deny"],
      ["other drive-letter case", secret.replace(/^./, (c) => c.toLowerCase()), false, "deny"],
      ["Git Bash drive form", `/${drive}${posix(secret).slice(2)}`, false, "deny"],
      ["WSL drive form", `/mnt/${drive}${posix(secret).slice(2)}`, false, "deny"],
      ["extended-length prefix", `\\\\?\\${secret}`, false, "deny"],
      ["trailing dot", `${secret}.`, false, "deny"],
      ["trailing space", `${secret} `, false, "deny"],
      ["alternate data stream (refused by the resolver)", `${secret}::$DATA`, false, "refused"],
      ["administrative share on localhost (refused by the resolver)", `\\\\localhost\\${secret[0]}$${secret.slice(2)}`, false, "refused"],
      ["junction into the folder", path.join(project, "open", "link", "key.txt"), false, "deny"],
      ["~\\ home spelling", "~\\.ssh\\id_rsa", false, "deny"],
      ["~\\ home spelling, allowed file", "~\\notes\\a.txt", true, "deny"],
    ]
    // A server on POSIX with a Windows-side editor: these are joined under the session folder by the resolver, so they are
    // relative there and never name the file the label would show.
    const posixRows: ReadonlyArray<Row> = [
      ["drive letter with backslashes", secret.replaceAll("/", "\\").replace(/^/, "C:"), false, "relative"],
      ["drive letter with slashes", `C:${secret}`, false, "relative"],
      ["rooted backslash path", secret.replaceAll("/", "\\"), false, "relative"],
      ["UNC share", `\\\\localhost${secret.replaceAll("/", "\\")}`, false, "relative"],
      ["device namespace", `\\\\.\\C:${secret.replaceAll("/", "\\")}`, false, "relative"],
    ]
    return [...common, ...(windowsOnly ? windows : posixRows)]
  }

  it.live("every spelling of a denied path is dropped, and an allowed one is kept", () =>
    Effect.gen(function* () {
      const project = (yield* tmpdirScoped()).path
      const home = Global.Path.home.replaceAll("\\", "/")
      const rows = matrix(project)
      const run = (rules: Parameters<typeof prepare>[1]) =>
        Effect.gen(function* () {
          yield* prepare(project, rules)
          return yield* Effect.forEach(rows, ([name, file]) =>
            admit({ text: "hi", editor: { path: file } }).pipe(
              Effect.map((payload) => [name, payload.editor !== undefined] as const),
            ),
          )
        }).pipe(provide(project))
      const denied = yield* run([
        allow,
        { action: "Read", resource: "secret/*", effect: "deny" },
        { action: "Read", resource: `${home}/.ssh/*`, effect: "deny" },
      ])
      // Control: with no deny rule a "deny" row is kept, so the rule is what drops it. "refused" and "relative" rows stay
      // dropped, which is what marks them as not deny cells.
      const control = yield* run([allow])
      expect([...denied]).toEqual(rows.map(([name, , kept]) => [name, kept] as const))
      expect([...control]).toEqual(rows.map(([name, , kept, why]) => [name, why === "deny"] as const))
    }),
  )

  // The cells of a path that a link leads out of (classes 3 and 8). In an untrusted folder the request names the place
  // the link leads to, so a Read deny written for the path as the project spells it decides only because that spelling
  // is one of the request's `leads`. The editor's path goes through a folder link out (`cfg/s`) or is a file link out
  // (`key.txt`), and the rule names it by the relative and by the absolute path. A trusted folder is the control, and
  // with no deny the field is kept in both.
  for (const trusted of [true, false]) {
    for (const link of ["folder", "file"] as const) {
      const row = link === "file" && !canLinkFile ? it.live.skip : it.live
      row(
        `a Read deny for the spelling of a ${link} link out drops the field (${trusted ? "trusted" : "untrusted"})`,
        () =>
          Effect.gen(function* () {
            const root = (yield* tmpdirScoped()).path
            const project = path.join(root, "project")
            const outside = path.join(root, "outside")
            fs.mkdirSync(project)
            fs.mkdirSync(outside)
            fs.writeFileSync(path.join(outside, "s"), "SECRET-MARKER")
            if (link === "folder") fs.symlinkSync(outside, path.join(project, "cfg"), "junction")
            if (link === "file") fs.symlinkSync(path.join(outside, "s"), path.join(project, "key.txt"), "file")
            const spelled = link === "folder" ? "cfg/s" : "key.txt"
            const file = path.join(project, spelled)
            const editor = { path: file, selection: { start: 1, end: 1, text: "SECRET-MARKER" } }
            const rulesets: ReadonlyArray<readonly [string, Permission.Ruleset]> = [
              ["no deny", [allow]],
              ["relative deny", [allow, { action: "Read", resource: spelled, effect: "deny" }]],
              ["absolute deny", [allow, { action: "Read", resource: file.replaceAll("\\", "/"), effect: "deny" }]],
            ]
            const kept = yield* Effect.forEach(rulesets, ([name, rules]) =>
              Effect.gen(function* () {
                yield* prepare(project, rules)
                const payload = yield* admit({ text: "hi", editor })
                return [name, payload.text, payload.editor !== undefined] as const
              }).pipe(provide(project, trusted)),
            )
            expect(kept).toEqual([
              ["no deny", "hi", true],
              ["relative deny", "hi", false],
              ["absolute deny", "hi", false],
            ])
          }),
      )
    }
  }

  // m5-quality, item 12 (classes 3 and 8): a configuration policy refuses the editor field as it refuses the Read tool,
  // though the check runs no plugin hook: the policy plugin's own decision is installed for it. A plain file, a folder
  // link out and a file link out, by the path as the project spells it, from the person's document and from their
  // organization, in a trusted and an untrusted folder. A policy for another file is the control.
  for (const trusted of [true, false])
    for (const link of ["plain", "folder", "file"] as const)
      for (const from of ["user", "organization"] as const)
        (link === "file" && !canLinkFile ? it.live.skip : it.live)(
          `a ${from} policy Read deny drops the field: ${link === "plain" ? "a plain file" : `a ${link} link out`} (${trusted ? "trusted" : "untrusted"})`,
          () =>
            Effect.gen(function* () {
              const root = (yield* tmpdirScoped()).path
              const project = path.join(root, "project")
              const outside = path.join(root, "outside")
              fs.mkdirSync(path.join(project, "plain"), { recursive: true })
              fs.mkdirSync(outside)
              fs.writeFileSync(path.join(outside, "s"), "SECRET-MARKER")
              fs.writeFileSync(path.join(project, "plain", "s"), "SECRET-MARKER")
              if (link === "folder") fs.symlinkSync(outside, path.join(project, "cfg"), "junction")
              if (link === "file") fs.symlinkSync(path.join(outside, "s"), path.join(project, "key.txt"), "file")
              const spelled = { plain: "plain/s", folder: "cfg/s", file: "key.txt" }[link]
              const editor = { path: path.join(project, spelled), selection: { start: 1, end: 1, text: "SECRET-MARKER" } }
              const kept = yield* Effect.forEach(["other.txt", spelled], (named) =>
                Effect.scoped(
                  Effect.gen(function* () {
                    yield* prepare(project, [allow])
                    yield* installPolicy(from, [{ action: "permission", resource: `Read:${named}`, effect: "deny" }])
                    const payload = yield* admit({ text: "hi", editor })
                    return [named, payload.editor !== undefined] as const
                  }).pipe(provide(project, trusted)),
                ),
              )
              expect(kept).toEqual([
                ["other.txt", true],
                [spelled, false],
              ])
            }),
        )

  // Fix loop 11 (classes 3 and 4): from a session folder below the worktree the project spells the file `../cfg/s`. A
  // trusted folder checks that spelling; an untrusted one checks the place the link leads to, with the spelling as a
  // lead that is now tried relative to the session folder although it climbs out of it.
  for (const trusted of [true, false])
    it.live(`a Read deny for the ../ spelling of a link out drops the field (${trusted ? "trusted" : "untrusted"})`, () =>
      Effect.gen(function* () {
        const root = (yield* tmpdirScoped()).path
        const project = path.join(root, "project")
        const below = path.join(project, "plain")
        const outside = path.join(root, "outside")
        fs.mkdirSync(below, { recursive: true })
        fs.mkdirSync(outside)
        fs.writeFileSync(path.join(outside, "s"), "SECRET-MARKER")
        fs.symlinkSync(outside, path.join(project, "cfg"), "junction")
        const file = path.join(project, "cfg", "s")
        const editor = { path: file, selection: { start: 1, end: 1, text: "SECRET-MARKER" } }
        const rulesets: ReadonlyArray<readonly [string, Permission.Ruleset]> = [
          ["no deny", [allow]],
          ["dot-dot deny", [allow, { action: "Read", resource: "../cfg/s", effect: "deny" }]],
          ["dot-dot pattern deny", [allow, { action: "Read", resource: "../cfg/*", effect: "deny" }]],
          ["absolute deny", [allow, { action: "Read", resource: file.replaceAll("\\", "/"), effect: "deny" }]],
        ]
        const kept = yield* Effect.forEach(rulesets, ([name, rules]) =>
          Effect.gen(function* () {
            yield* prepare(below, rules, project)
            const payload = yield* admit({ text: "hi", editor })
            return [name, payload.editor !== undefined] as const
          }).pipe(provide(below, trusted, project)),
        )
        expect(kept).toEqual([
          ["no deny", true],
          ["dot-dot deny", false],
          ["dot-dot pattern deny", false],
          ["absolute deny", false],
        ])
      }),
    )

  it.live("a ~ spelling is resolved before the rule decides", () =>
    Effect.gen(function* () {
      const project = (yield* tmpdirScoped()).path
      const home = Global.Path.home.replaceAll("\\", "/")
      const results = yield* Effect.gen(function* () {
        yield* prepare(project, [allow, { action: "Read", resource: `${home}/.ssh/*`, effect: "deny" }])
        return [
          (yield* admit({ text: "hi", editor: { path: "~/.ssh/id_rsa" } })).editor,
          (yield* admit({ text: "hi", editor: { path: "~/notes/a.txt" } })).editor,
        ]
      }).pipe(provide(project))
      expect(results).toEqual([undefined, { path: "~/notes/a.txt" }])
    }),
  )

  it.live("a relative path and a selection that ends before it starts drop the field", () =>
    Effect.gen(function* () {
      const project = (yield* tmpdirScoped()).path
      const results = yield* Effect.gen(function* () {
        yield* prepare(project, [allow])
        return [
          (yield* admit({ text: "hi", editor: { path: "src/a.ts" } })).editor,
          (yield* admit({
            text: "hi",
            editor: { path: path.join(project, "a.ts"), selection: { start: 5, end: 4, text: "x" } },
          })).editor,
        ]
      }).pipe(provide(project))
      expect(results).toEqual([undefined, undefined])
    }),
  )
})

// Review of m5-quality fix loop 1 (classes 3 and 8): a mentioned file (`@path`, sent as a `file:` attachment) reaches the
// model whole at admission, without a read. A Read deny rule, or a configuration policy of the person or their
// organization, leaves it out with one log line, as the reference drops a mentioned file its read rules deny and as the
// editor field is dropped; the prompt and the other mentions are admitted. A plain file, a file through a folder link out
// and a file link out, by the path as the project spells it, in a trusted and an untrusted folder. A mention of another
// file is the control in every row, and with no deny both are kept.
describe("mentioned files at admission", () => {
  const layout = (root: string, link: "plain" | "folder" | "file") => {
    const project = path.join(root, "project")
    const outside = path.join(root, "outside")
    fs.mkdirSync(path.join(project, "plain"), { recursive: true })
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, "s"), "SECRET-MARKER")
    fs.writeFileSync(path.join(project, "plain", "s"), "SECRET-MARKER")
    fs.writeFileSync(path.join(project, "other.txt"), "open notes")
    if (link === "folder") fs.symlinkSync(outside, path.join(project, "cfg"), "junction")
    if (link === "file") fs.symlinkSync(path.join(outside, "s"), path.join(project, "key.txt"), "file")
    const spelled = { plain: "plain/s", folder: "cfg/s", file: "key.txt" }[link]
    return { project, spelled }
  }
  const mentions = (project: string, spelled: string) =>
    [spelled, "other.txt"].map((file) => ({ uri: pathToFileURL(path.join(project, file)).href, name: file }))
  const kept = (payload: { files?: ReadonlyArray<{ name?: string; data: string }> }) =>
    (payload.files ?? []).map((file) => [file.name, Buffer.from(file.data, "base64").toString()] as const)

  for (const trusted of [true, false])
    for (const link of ["plain", "folder", "file"] as const)
      (link === "file" && !canLinkFile ? it.live.skip : it.live)(
        `a Read deny leaves out ${link === "plain" ? "a plain file" : `a file through a ${link} link out`} (${trusted ? "trusted" : "untrusted"})`,
        () =>
          Effect.gen(function* () {
            const { project, spelled } = layout((yield* tmpdirScoped()).path, link)
            const file = path.join(project, spelled)
            const rulesets: ReadonlyArray<readonly [string, Permission.Ruleset]> = [
              ["no deny", [allow]],
              ["relative deny", [allow, { action: "Read", resource: spelled, effect: "deny" }]],
              ["absolute deny", [allow, { action: "Read", resource: file.replaceAll("\\", "/"), effect: "deny" }]],
            ]
            const results = yield* Effect.forEach(rulesets, ([name, rules]) =>
              Effect.gen(function* () {
                yield* prepare(project, rules)
                const payload = yield* admit({ text: "hi", files: mentions(project, spelled) })
                return [name, payload.text, kept(payload)] as const
              }).pipe(provide(project, trusted)),
            )
            expect(results).toEqual([
              [
                "no deny",
                "hi",
                [
                  [spelled, "SECRET-MARKER"],
                  ["other.txt", "open notes"],
                ],
              ],
              ["relative deny", "hi", [["other.txt", "open notes"]]],
              ["absolute deny", "hi", [["other.txt", "open notes"]]],
            ])
          }),
      )

  for (const trusted of [true, false])
    for (const link of ["plain", "folder", "file"] as const)
      for (const from of ["user", "organization"] as const)
        (link === "file" && !canLinkFile ? it.live.skip : it.live)(
          `a ${from} policy Read deny leaves out ${link === "plain" ? "a plain file" : `a file through a ${link} link out`} (${trusted ? "trusted" : "untrusted"})`,
          () =>
            Effect.gen(function* () {
              const { project, spelled } = layout((yield* tmpdirScoped()).path, link)
              const results = yield* Effect.forEach(["unrelated.txt", spelled], (named) =>
                Effect.scoped(
                  Effect.gen(function* () {
                    yield* prepare(project, [allow])
                    yield* installPolicy(from, [{ action: "permission", resource: `Read:${named}`, effect: "deny" }])
                    const payload = yield* admit({ text: "hi", files: mentions(project, spelled) })
                    return [named, kept(payload).map(([name]) => name)] as const
                  }).pipe(provide(project, trusted)),
                ),
              )
              expect(results).toEqual([
                ["unrelated.txt", [spelled, "other.txt"]],
                [spelled, ["other.txt"]],
              ])
            }),
        )

  // A mentioned folder is sent as the list of what is in it, so its rule decides it too.
  it.live("a Read deny leaves out a mentioned folder", () =>
    Effect.gen(function* () {
      const project = (yield* tmpdirScoped()).path
      fs.mkdirSync(path.join(project, "secret"))
      fs.mkdirSync(path.join(project, "open"))
      fs.writeFileSync(path.join(project, "secret", "key.txt"), "SECRET-MARKER")
      fs.writeFileSync(path.join(project, "open", "a.txt"), "open notes")
      const folders = ["secret", "open"].map((name) => ({ uri: pathToFileURL(path.join(project, name)).href, name }))
      const results = yield* Effect.forEach(
        [
          ["no deny", [allow]],
          ["deny", [allow, { action: "Read", resource: "secret", effect: "deny" }]],
        ] as const,
        ([name, rules]) =>
          Effect.gen(function* () {
            yield* prepare(project, rules)
            const payload = yield* admit({ text: "hi", files: folders })
            return [name, kept(payload)] as const
          }).pipe(provide(project)),
      )
      expect(results).toEqual([
        [
          "no deny",
          [
            ["secret", "key.txt"],
            ["open", "a.txt"],
          ],
        ],
        ["deny", [["open", "a.txt"]]],
      ])
    }),
  )
})

describe("agent mentions at admission", () => {
  it.live("keeps the agents a subagent call can start, in order, and drops the rest", () =>
    Effect.gen(function* () {
      const project = (yield* tmpdirScoped()).path
      const payload = yield* Effect.gen(function* () {
        yield* prepare(project, [allow])
        return yield* admit({
          text: "hi",
          agents: [{ name: "helper" }, { name: "ghost" }, { name: "lead" }, { name: "both" }],
        })
      }).pipe(provide(project))
      expect(payload.agents?.map((agent) => agent.name)).toEqual(["helper", "both"])
    }),
  )
})
