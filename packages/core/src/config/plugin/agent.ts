export * as ConfigAgentPlugin from "./agent.js"

import { define } from "@orbit/plugin/effect/plugin"
import { Document, type Directory, type Entry } from "@orbit/schema/config"
import path from "path"
import { Effect, PubSub, Stream, type Types } from "effect"
import { Agent } from "../../agent.js"
import { Config } from "../../config.js"
import { ConfigTrust } from "../trust.js"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Permission } from "../../permission.js"
import { ManagedPolicy } from "../../managed-policy.js"
import { ProjectTrust } from "../../project-trust.js"
import { ConfigPermissionExpand } from "../expand-permissions.js"
import { AgentFile } from "./agent-file.js"
import { PlanMode } from "../../plan-mode.js"

// Keep in sync with the scan patterns and the name-strip regex in agent-file.ts.
const sourceDirectories = ["agent", "agents", "mode", "modes"] as const

export const Plugin = define({
  id: "orbit.config.agent",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const trust = yield* ProjectTrust.Service
    const managed = yield* ManagedPolicy.Service
    // The transform below is synchronous; run its log lines with this plugin's services so they reach the configured logger.
    const runSync = Effect.runSyncWith(yield* Effect.context<never>())
    // The documents that come from a file under agent/ or agents/, which define an agent instead of tuning it.
    const definitions = new WeakSet<Document>()
    const loadEntry = Effect.fnUntraced(function* (entry: Entry) {
      if (entry.type === "document") return [entry]
      if (entry.type !== "directory") return []
      // Until the folder is trusted, a file that a link leads out of it is not the repository's to define an agent with.
      const documents = yield* AgentFile.load(fs, entry.path, (file) => trust.supplies(entry, file))
      return documents.map((document) => {
        const inherited = inherit(entry, document)
        if (document.path !== undefined && AgentFile.defines(entry.path, document.path)) definitions.add(inherited)
        return inherited
      })
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
      const permissions = ConfigPermissionExpand.expandPermissions(
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

          // A file under agent/ or agents/ is a definition: it replaces what an earlier entry made of the same agent, and
          // nothing of that survives, its rules included. Everything else tunes the agent that is there. Plan keeps the
          // rules that Plan mode puts on it, so a file for it tunes, as a file under mode/ does.
          const defines = definitions.has(document)
          // Replacing starts again from a default that allows everything, so a folder that is not trusted may not do it
          // to an agent that exists (it could turn the read-only explore agent into one that edits), and it is not
          // allowed to tune one either. It may still define an agent that is new.
          if (defines && document.trusted === false && editor.get(agentID) !== undefined) continue
          const replaces = defines && document.trusted !== false && agentID !== PlanMode.agent
          if (replaces) editor.remove(agentID)
          const exists = editor.get(agentID) !== undefined
          const held = document.trusted === false && exists
          const skipped = held
            ? (["system", "description", "initial_prompt"] as const).filter(
                (field) => item[field] !== undefined && item[field].trim() !== "",
              )
            : []
          if (skipped.length > 0)
            runSync(
              Effect.logInfo("untrusted agent entry text held back", { agent: id, path: document.path, fields: skipped }),
            )
          editor.update(agentID, (agent) => {
            if (!exists) agent.permissions.push(...permissions)
            if (!exists) {
              agent.source = {
                scope: document.scope ?? "user",
                ...(document.path === undefined ? {} : { path: document.path }),
              }
              // Any agent in a file can be started as a subagent and can also run as the main agent.
              if (defines && document.trusted !== false) agent.mode = "all"
            }
            if (typeof item.model === "string") {
              agent.modelTier = item.model
              delete agent.model
            }
            if (typeof item.model === "object") {
              agent.model = {
                id: item.model.model,
                providerID: item.model.providerID,
                ...(item.model.variant === undefined ? {} : { variant: item.model.variant }),
              }
              delete agent.modelTier
            }
            if (item.effort !== undefined) agent.effort = item.effort
            if (item.tools !== undefined || item.disallowed_tools !== undefined) {
              const tools = { ...agent.tools }
              // A `*` in the allow list means every tool, which is the same as no list. In the deny list it means every tool.
              if (item.tools !== undefined && item.tools.includes("*")) delete tools.allow
              else if (item.tools !== undefined) tools.allow = [...item.tools]
              // A folder that is not trusted may only add to a deny list that is there: replacing it could clear the
              // person's own denies. A trusted document replaces it, as it does the rest of the entry.
              if (item.disallowed_tools !== undefined)
                tools.deny =
                  document.trusted === false
                    ? [...new Set([...(tools.deny ?? []), ...item.disallowed_tools])]
                    : [...item.disallowed_tools]
              agent.tools = tools
            }
            if (item.permission_mode !== undefined) agent.permissionMode = item.permission_mode
            if (item.mcp_servers !== undefined) agent.mcpServers = mutable(item.mcp_servers)
            if (item.hooks !== undefined) agent.hooks = mutable(item.hooks)
            if (item.skills !== undefined) agent.skills = [...item.skills]
            if (
              item.initial_prompt !== undefined &&
              item.initial_prompt.trim() !== "" &&
              !held
            )
              agent.initialPrompt = item.initial_prompt
            if (item.memory !== undefined) agent.memory = item.memory
            if (item.background === true) agent.background = true
            if (item.background === false) delete agent.background
            if (item.isolation !== undefined) agent.isolation = item.isolation
            if (item.context !== undefined) agent.context = { ...agent.context, ...item.context }
            if (item.request !== undefined) {
              Object.assign(agent.request.headers, item.request.headers ?? {})
              Object.assign(agent.request.body, item.request.body ?? {})
            }
            // An agent's own prompt makes a session skip the person's `system_prompt`, and its description and first
            // message are text the model reads, so a folder that is not trusted may write them only for an agent it
            // defines itself.
            if (item.system !== undefined && !held) agent.system = item.system
            if (item.description !== undefined && !held)
              agent.description = item.description
            if (item.mode !== undefined) agent.mode = item.mode
            if (item.hidden !== undefined) agent.hidden = item.hidden
            if (item.color !== undefined) agent.color = item.color
            if (item.steps !== undefined || item.max_turns !== undefined) agent.steps = item.steps ?? item.max_turns
            if (item.permissions !== undefined && document.scope !== "managed" && !only) {
              agent.permissions.push(...ConfigPermissionExpand.expandPermissions(item.permissions, global.home))
            }
          })
        }
      }
    })
  }),
})

// A copy the transform may edit: the document it came from stays as it was read.
function mutable<A>(value: A) {
  return structuredClone(value) as Types.DeepMutable<A>
}

// Matches anything at or under <root>/{agent,agents,mode,modes}. No file-suffix
// check: directory-level events such as renames carry no per-file paths.
function isAgentSource(entries: Entry[], file: string) {
  return entries.some(
    (entry) =>
      entry.type === "directory" &&
      sourceDirectories.some((name) => FSUtil.contains(path.join(entry.path, name), file)),
  )
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
