export * as ConfigAgentPlugin from "./agent.js"

import { define } from "@orbit/plugin/effect/plugin"
import { Document, type Directory, type Entry } from "@orbit/schema/config"
import path from "path"
import { Effect, PubSub, Stream } from "effect"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { ConfigTrust } from "../trust.js"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Permission } from "../../permission.js"
import { ManagedPolicy } from "../../managed-policy.js"
import { ProjectTrust } from "../../project-trust.js"
import type { FileAccess } from "../../file-access.js"
import type { ReadTool } from "../../tool/plugin/read.js"
import type { EditTool } from "../../tool/plugin/edit.js"
import { ToolNames } from "../../tool/names.js"
import { AgentFile } from "./agent-file.js"

// Keep in sync with the scan patterns and the name-strip regex in agent-file.ts.
const sourceDirectories = ["agent", "agents", "mode", "modes"] as const
type PathAction = FileAccess.ExternalDirectoryAuthorization["action"] | typeof ReadTool.name | typeof EditTool.name
const pathActions = ["external_directory", "Read", "Edit"] as const satisfies readonly PathAction[]

export const Plugin = define({
  id: "orbit.config.agent",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const trust = yield* ProjectTrust.Service
    const managed = yield* ManagedPolicy.Service
    const loadEntry = Effect.fnUntraced(function* (entry: Entry) {
      if (entry.type === "document") return [entry]
      if (entry.type !== "directory") return []
      // Until the folder is trusted, a file that a link leads out of it is not the repository's to define an agent with.
      const documents = yield* AgentFile.load(fs, entry.path, (file) => trust.supplies(entry, file))
      return documents.map((document) => inherit(entry, document))
    })
    const load = Effect.fn("ConfigAgentPlugin.load")(function* () {
      return yield* Effect.forEach(yield* config.entries(), loadEntry).pipe(Effect.map((documents) => documents.flat()))
    })
    const loaded = { documents: [] as Document[] }
    const reload = load().pipe(
      Effect.tap((documents) => Effect.sync(() => (loaded.documents = documents))),
      Effect.andThen(ctx.agent.reload()),
    )
    // One trigger feed serializes reloads and shares one debounce window;
    // subscribing before the initial scan means updates racing the scan still
    // trigger a rebuild. Each source is subscribed eagerly on its own fiber
    // (Stream.merge and Stream.debounce both open upstream a fiber hop later)
    // so no update slips through while the debounce starts its pull.
    const changes = yield* PubSub.sliding<void>(1)
    const notify = () => PubSub.publish(changes, undefined)
    yield* config.changes().pipe(
      Stream.filterEffect((update) => Effect.map(config.entries(), (entries) => isAgentSource(entries, update.path))),
      Stream.runForEach(notify),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "config.updated"),
      Stream.runForEach(notify),
      Effect.forkScoped({ startImmediately: true }),
    )
    const updates = yield* PubSub.subscribe(changes)
    yield* Stream.fromSubscription(updates).pipe(
      Stream.debounce("100 millis"),
      Stream.runForEach(() => reload),
      Effect.forkScoped({ startImmediately: true }),
    )
    loaded.documents = yield* load()
    yield* ctx.agent.transform((editor) => {
      // Managed rules are enforced from ManagedPolicy (Permission.evaluateInput), not by copying them into agents, so a
      // managed document adds none. Under managed_permissions_only no document adds any: the agents keep only their
      // built-in rules.
      const only = managed.current().restrictions.managed_permissions_only === true
      const permissions = expandPermissions(
        loaded.documents.flatMap((document) =>
          document.scope === "managed" || only ? [] : (document.info.permissions ?? []),
        ),
        global.home,
      )
      const configuredDefault = Config.latest(loaded.documents, "default_agent")
      if (configuredDefault !== undefined) editor.default(Agent.ID.make(configuredDefault))
      for (const current of editor.list()) {
        editor.update(current.id, (agent) => agent.permissions.push(...permissions))
      }

      for (const document of loaded.documents) {
        for (const [id, item] of Object.entries(document.info.agents ?? {})) {
          const agentID = Agent.ID.make(id)
          if (item.disabled) {
            editor.remove(agentID)
            continue
          }

          const exists = editor.get(agentID) !== undefined
          editor.update(agentID, (agent) => {
            if (!exists) agent.permissions.push(...permissions)
            if (item.model !== undefined)
              agent.model = {
                id: item.model.model,
                providerID: item.model.providerID,
                ...(item.model.variant === undefined ? {} : { variant: item.model.variant }),
              }
            if (item.request !== undefined) {
              Object.assign(agent.request.headers, item.request.headers ?? {})
              Object.assign(agent.request.body, item.request.body ?? {})
            }
            if (item.system !== undefined) agent.system = item.system
            if (item.description !== undefined) agent.description = item.description
            if (item.mode !== undefined) agent.mode = item.mode
            if (item.hidden !== undefined) agent.hidden = item.hidden
            if (item.color !== undefined) agent.color = item.color
            if (item.steps !== undefined) agent.steps = item.steps
            if (item.permissions !== undefined && document.scope !== "managed" && !only) {
              agent.permissions.push(...expandPermissions(item.permissions, global.home))
            }
          })
        }
      }
    })
  }),
})

// Matches anything at or under <root>/{agent,agents,mode,modes}. No file-suffix
// check: directory-level events such as renames carry no per-file paths.
function isAgentSource(entries: Entry[], file: string) {
  return entries.some(
    (entry) =>
      entry.type === "directory" &&
      sourceDirectories.some((name) => FSUtil.contains(path.join(entry.path, name), file)),
  )
}

function expandPermissions(rules: Permission.Ruleset, home: string): Permission.Ruleset {
  // Expand only resources tools resolve as filesystem paths. Bash resources are raw shell text:
  // rewriting `$HOME/private/**` would miss `$HOME/private/key`, and safe expansion needs shell-aware parsing.
  return rules.map((rule) =>
    isPathAction(rule.action) ? { ...rule, resource: expandHome(rule.resource, home) } : rule,
  )
}

function isPathAction(action: string) {
  return pathActions.some((item) => item === ToolNames.canonical(action))
}

function expandHome(resource: string, home: string) {
  if (resource === "~" || resource === "$HOME") return home
  const relative = resource.startsWith("~/")
    ? resource.slice(2)
    : resource.startsWith("$HOME/") || resource.startsWith("$HOME\\")
      ? resource.slice(6)
      : undefined
  if (relative !== undefined) return (path.posix.isAbsolute(home) ? path.posix : path.win32).join(home, relative)
  return resource
}

// An agent file takes the scope of the directory that holds it. While that directory's folder is untrusted it is cut down
// like the documents of the folder: its prompt and what only describes the agent stay, and its request overrides and
// every allow or ask rule go, so a repository cannot widen what an agent may do.
function inherit(entry: Directory, document: Document) {
  if (entry.trusted !== false) return new Document({ ...document, scope: entry.scope })
  // An agent names no paths, so what matters about the place is only the folder it belongs to.
  const sanitized = ConfigTrust.sanitize(document.info, {
    roots: [ConfigTrust.holder(entry.path)],
    directory: entry.path,
  })
  return new Document({
    ...document,
    scope: entry.scope,
    trusted: false,
    withheld: sanitized.withheld,
    info: sanitized.info,
  })
}
