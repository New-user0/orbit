export * as Permission from "./permission.js"

import { makeLocationNode } from "@orbit/util/effect/app-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import path from "path"
import { Context, Deferred, Effect, Exit, Layer, Schema } from "effect"
import { Permission } from "@orbit/schema/permission"
import { Bus } from "./bus.js"
import { Location } from "./location.js"
import { Agent } from "./agent.js"
import { SessionErrors } from "./session/error.js"
import { SessionSchema } from "./session/schema.js"
import { SessionStore } from "./session/store.js"
import { Wildcard } from "./util/wildcard.js"
import { ToolNames } from "./tool/names.js"
import { PermissionSaved } from "./permission/saved.js"
import { PluginHooks } from "./plugin/hooks.js"
import { ManagedNetwork } from "./managed-network.js"
import { ManagedPolicy } from "./managed-policy.js"
import { ToolCurrentCall } from "./tool/current-call.js"

const PermissionEffect = Permission.Effect
export { PermissionEffect as Effect }
export { Rule, Ruleset } from "@orbit/schema/permission"
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]

export const ID = Permission.ID
export type ID = typeof ID.Type

export const Source = Permission.Source
export type Source = typeof Source.Type

const RequestFields = {
  sessionID: Permission.Request.fields.sessionID,
  action: Permission.Request.fields.action,
  resources: Permission.Request.fields.resources,
  save: Permission.Request.fields.save,
  metadata: Permission.Request.fields.metadata,
  source: Permission.Request.fields.source,
}

export const Request = Permission.Request
export type Request = typeof Request.Type

export const Reply = Permission.Reply
export type Reply = typeof Reply.Type

export const AssertInput = Schema.Struct({
  id: ID.pipe(Schema.optional),
  ...RequestFields,
  // Other spellings of a resource that rules may be written against, keyed by that resource. They steer evaluation
  // only: they stay off the public Request and never widen what an "always" reply saves. An alias belongs to its own
  // resource and no other, so a resource without aliases is never lifted by a rule that only an alias of another
  // resource matches.
  aliases: Schema.Record(Schema.String, Schema.Array(Schema.String)).pipe(Schema.optional),
  // Resources that are where a link in a project that is not trusted leads out to. The allows that Orbit gives every
  // agent for its own folders (`Agent.folders`) do not decide them, only the person's own rules and approvals do. They
  // stay off the public Request.
  escaped: Schema.Array(Schema.String).pipe(Schema.optional),
  // Where each resource really leads once its links are followed, keyed by that resource, in a project that is trusted.
  // They steer evaluation only and stay off the public Request: a deny or an ask that matches such a place applies to the
  // resource, and an allow that matches only such a place never does.
  leads: Schema.Record(Schema.String, Schema.Array(Schema.String)).pipe(Schema.optional),
  // Set on the deny-only checks a shell command makes for the files it names: the rules that a mode puts on an agent
  // (`Agent.modeRule`) do not apply to them, since the mode asks about the command itself.
  probe: Schema.Boolean.pipe(Schema.optional),
  agent: Agent.ID.pipe(Schema.optional),
}).annotate({ identifier: "Permission.AssertInput" })
export type AssertInput = typeof AssertInput.Type

export const ReplyInput = Schema.Struct({
  requestID: ID,
  reply: Reply,
  message: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "Permission.ReplyInput" })
export type ReplyInput = typeof ReplyInput.Type

export const AskResult = Schema.Struct({
  id: ID,
  effect: Permission.Effect,
}).annotate({ identifier: "Permission.AskResult" })
export type AskResult = typeof AskResult.Type

export { Event } from "@orbit/schema/permission"

export class DeclinedError extends Schema.TaggedError<DeclinedError>()("Permission.DeclinedError", {}) {}

export class CorrectedError extends Schema.TaggedError<CorrectedError>()("Permission.CorrectedError", {
  feedback: Schema.String,
}) {}

export class BlockedError extends Schema.TaggedError<BlockedError>()("Permission.BlockedError", {
  rules: Permission.Ruleset,
  permission: Schema.String,
  resources: Schema.Array(Schema.String),
  reason: Schema.String.pipe(Schema.optional),
}) {
  override get message() {
    return this.reason ?? `Permission denied: ${this.permission}`
  }
}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Permission.NotFoundError", {
  requestID: ID,
}) {}

export type Error = BlockedError | CorrectedError

// The resource and its own aliases form one combined subject: the last rule matching any of them decides, so a later
// allow written against one spelling still lifts an earlier broad deny, exactly as it does without aliases. A pattern
// is matched against every spelling alike, so one that starts with a wildcard (*.example.com) can also match text
// inside an alias, such as a query string that ends with it.
export function evaluate(
  action: string,
  resource: string,
  rules: Permission.Ruleset,
  aliases: ReadonlyArray<string> = [],
): Permission.Rule {
  const subjects = [resource, ...aliases]
  return (
    rules.findLast(
      (rule) =>
        actionMatches(action, rule.action) && subjects.some((subject) => Wildcard.match(subject, rule.resource)),
    ) ?? fallthrough(action)
  )
}

// A shell command that changes how its program is found or loaded (a PATH, LD_*, DYLD_*, BASH_ENV, ENV or IFS assignment,
// or an `env` option) is lifted by a saved approval only when that approval is its exact text, so a grant saved for the
// program, or an `env *` saved earlier, does not lift the spellings matched below (class 8). Other spellings, such as a
// quoted assignment, are not matched and `env *` still lifts them (follow-up).
const STEERING = /(?:^|\s)(?:(?:PATH|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_\w*|BASH_ENV|ENV|IFS)=|env\s+(?:\S+\s+)*?-)/i

function steersProgram(action: string, resource: string) {
  return ToolNames.spellings(action).some((name) => name.toLowerCase() === "bash") && STEERING.test(resource)
}

// The ask that stands for "no rule said anything", told apart from a rule that asks by identity, since a rule can be
// written `* * ask` and look the same.
const fallthroughs = new WeakSet<Permission.Rule>()

function fallthrough(action: string): Permission.Rule {
  const rule: Permission.Rule = { action, resource: "*", effect: "ask" }
  fallthroughs.add(rule)
  return rule
}

/** Whether `rule`, as `evaluate` returned it, is the default ask that no configured or saved rule matched. */
export function isFallthrough(rule: Permission.Rule) {
  return fallthroughs.has(rule)
}

// A rule names an action the way it was written: `edit` and `Edit` are one action, as `shell` and `Bash` are, so a rule
// written before the tools took their current names still decides. Only the spellings of one tool are equal, never two tools.
export function actionMatches(action: string, pattern: string) {
  return ToolNames.spellings(action).some((spelling) => Wildcard.match(spelling, pattern))
}

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  return rulesets.flat()
}

export interface Interface {
  readonly close: Effect.Effect<void>
  readonly ask: (input: AssertInput) => Effect.Effect<AskResult, SessionErrors.NotFoundError>
  readonly assert: (input: AssertInput) => Effect.Effect<void, Error | SessionErrors.NotFoundError>
  /**
   * Whether `assert` would fail with a block for this input, decided by the configured deny rules (agent, session and
   * project), the managed rules and the managed denied domains, and nothing else. It asks nobody, creates no request,
   * publishes nothing, runs no plugin hook and reads no grant. A caller that must show several questions in a row asks it
   * for every one of them first, so a deny anywhere stops the call before the first question. A hook that turns an ask into
   * a deny is not seen here; the later `assert` still honours it.
   */
  readonly denied: (input: AssertInput) => Effect.Effect<boolean, SessionErrors.NotFoundError>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, NotFoundError>
  readonly get: (id: ID) => Effect.Effect<Request | undefined>
  readonly forSession: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Request>>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
  /** The tool call that was executing when a still-pending request was made, if one was. */
  readonly callOf: (id: ID) => Effect.Effect<ToolCurrentCall.Call | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/Permission") {}

interface Pending {
  readonly request: Request
  readonly agent?: Agent.ID
  // Kept here rather than on the public Request so re-evaluating a pending request after an "always" reply sees them.
  readonly aliases?: AssertInput["aliases"]
  readonly escaped?: AssertInput["escaped"]
  readonly leads?: AssertInput["leads"]
  readonly deferred: Deferred.Deferred<void, DeclinedError | CorrectedError>
  // The tool call that was executing when the request was made, for deciding and explaining it. Never on the public Request.
  readonly call?: ToolCurrentCall.Call
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const location = yield* Location.Service
    const agents = yield* Agent.Service
    const sessions = yield* SessionStore.Service
    const saved = yield* PermissionSaved.Service
    const hooks = yield* PluginHooks.Service
    const managed = yield* ManagedPolicy.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    // The session folder and the project's worktree as written and as the disk has them. A session reached through a link
    // gets real-path leads, so a lead is also written in the project's own spelling before rules are matched against it.
    const spelled = [location.directory, path.resolve(location.project.directory)]
    // Any failure keeps the spelled path, not only NotFound: `resolve` dies on a link loop, and a folder that cannot be
    // resolved must not stop the permission layer from starting.
    const realOf = (folder: string) =>
      fs.resolve(folder).pipe(
        Effect.map(FSUtil.normalizePath),
        Effect.catchCause(() => Effect.succeed(folder)),
      )
    const real = yield* Effect.forEach(spelled, realOf)
    // Orbit's own folders as spelled and as the disk has them. An allow of Orbit's own is written for both, so a rule the
    // person wrote for the spelling (a deny on the linked config folder) must also decide a place named by its real path.
    const orbitSpelled = [global.data, global.tmp, global.config].map((folder) => path.resolve(folder))
    const orbitReal = yield* Effect.forEach(orbitSpelled, realOf)
    const respelled = (action: string, resource: string) => {
      const canonical = ToolNames.canonical(action)
      if (canonical !== "external_directory" && canonical !== "Read" && canonical !== "Edit") return []
      return orbitReal.flatMap((folder, index) => {
        const inside = path.relative(folder, resource)
        return inside === "" || inside.startsWith("..") || path.isAbsolute(inside)
          ? []
          : [path.join(orbitSpelled[index]!, inside)]
      })
    }
    const pending = new Map<ID, Pending>()
    // Orbit's own allows are marked where `Agent.folders` makes them, not recognised by value: a copy that an agent took
    // of them, as Explore does, keeps the mark, and a rule of the person's with the same value does not have it.
    const own = (rules: Permission.Ruleset) => rules.filter((rule) => !Agent.isOwnFolder(rule))
    // Saved approvals are the person's own answers, so they join after Orbit's allows are taken out: one that has the
    // same value as an allow of Orbit's (an "always" for the global config folder) still decides a place a link leads to.
    // FileAccess asks inside the project with a path relative to the session folder, while a rule written with `~`,
    // `$HOME` or a drive path is absolute. A file tool's place is therefore also tried by where it is.
    const resolved = (action: string, resource: string) => {
      const canonical = ToolNames.canonical(action)
      return (canonical === "Read" || canonical === "Edit") && !path.isAbsolute(resource)
        ? [path.resolve(location.directory, resource)]
        : []
    }
    const decide = (
      input: Pick<AssertInput, "action" | "aliases" | "escaped" | "leads">,
      resource: string,
      rules: Permission.Ruleset,
      approvals: Permission.Ruleset = [],
    ) => {
      const all = [
        ...(input.escaped?.includes(resource) ? own(rules) : rules),
        ...(steersProgram(input.action, resource)
          ? approvals.filter((rule) => rule.resource === resource && !/[*?]/.test(rule.resource))
          : approvals),
      ]
      const decided = evaluate(input.action, resource, all, [
        ...(input.aliases?.[resource] ?? []),
        ...resolved(input.action, resource),
        ...respelled(input.action, resource),
      ])
      if (decided.effect === "deny") return decided
      const led = stricter(input.action, input.leads?.[resource], all)
      if (led.effect === "deny") return { action: input.action, resource: "*", effect: "deny" } satisfies Permission.Rule
      if (led.effect !== "ask" || decided.effect !== "allow") return decided
      const rule = { action: input.action, resource: "*", effect: "ask" } satisfies Permission.Rule
      // A lead that only the built-in `external_directory * ask` decided is still the default question.
      return led.defaulted ? Agent.defaultAsk(rule) : rule
    }
    let closed = false

    const close = Effect.gen(function* () {
      closed = true
      yield* Effect.forEach(Array.from(pending.values()), (item) =>
        bus
          .publish(Permission.Event.Replied, {
            sessionID: item.request.sessionID,
            requestID: item.request.id,
            reply: "reject",
          })
          .pipe(Effect.ensuring(Deferred.fail(item.deferred, new DeclinedError()))),
      )
      pending.clear()
    }).pipe(Effect.uninterruptible)
    yield* Effect.addFinalizer(() => close)

    const savedRules = Effect.fnUntraced(function* () {
      return (yield* saved.list({ projectID: location.project.id })).map(
        (item): Permission.Rule => ({
          action: item.action,
          resource: item.resource,
          effect: "allow",
        }),
      )
    })

    // Under managed_permissions_only a session can only narrow what the agent allows, never widen it.
    const configured = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, agentID?: Agent.ID) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionErrors.NotFoundError({ sessionID })
      const name = agentID ?? session.agent
      const agent = yield* agents.resolve(name)
      const own = session.permissions ?? []
      return {
        // The agent the config rules came from, so an ask or session that names none still gets the default agent's
        // managed rules.
        agent: agent?.id ?? name,
        rules: merge(
          agent?.permissions ?? missingAgentPermissions,
          managed.current().restrictions.managed_permissions_only ? own.filter((rule) => rule.effect !== "allow") : own,
        ),
      }
    })

    // The last managed rule that matches a resource decides it. No match leaves the resource to the hooks and the rest.
    function managedEffect(
      input: Pick<AssertInput, "action" | "aliases" | "leads">,
      resource: string,
      rules: Permission.Ruleset,
    ): Permission.Effect | undefined {
      const subjects = [
        resource,
        ...resolved(input.action, resource),
        ...respelled(input.action, resource),
        ...(input.aliases?.[resource] ?? []),
      ]
      const own = rules.findLast(
        (rule) =>
          actionMatches(input.action, rule.action) &&
          subjects.some((subject) => Wildcard.match(subject, rule.resource)),
      )?.effect
      if (own === "deny") return own
      const led = stricter(input.action, input.leads?.[resource], rules).effect
      return led === "deny" || (led === "ask" && own !== "ask") ? led : own
    }

    // What the rules say about the real places a resource leads to, when it is a deny or an ask. An allow written for such a
    // place never lifts the resource, since the person wrote it for the place and not for the link's spelling.
    // Rules are written as the project names its files, so one lead is tried in every spelling a rule can be written in: the
    // real path, the same place under the project's folders as they are spelled (a session folder reached through a link has
    // real-path leads), and each of those relative to the session folder. The spelling of the resource itself is not a
    // subject: a rule that names only the link must not decide the place it leads to, so the Plan agent's allow for its
    // folder is also written for the folder's real path (`PlanPlugin`). The last rule that matches any of them decides, as
    // for aliases.
    function stricter(
      action: string,
      leads: ReadonlyArray<string> | undefined,
      rules: Permission.Ruleset,
    ) {
      const effects = (leads ?? []).flatMap((lead) => {
        const places = [
          lead,
          ...real.flatMap((folder, index) =>
            FSUtil.contains(folder, lead) ? [path.join(spelled[index]!, path.relative(folder, lead))] : [],
          ),
        ]
        const relatives = places.flatMap((place) => {
          const relative = path.relative(location.directory, place)
          return relative === "" || relative.startsWith("..") || path.isAbsolute(relative)
            ? []
            : [relative.replaceAll("\\", "/")]
        })
        const subjects = [...places, ...relatives]
        const rule = rules.findLast(
          (rule) => actionMatches(action, rule.action) && subjects.some((subject) => Wildcard.match(subject, rule.resource)),
        )
        return rule?.effect === "deny" || rule?.effect === "ask" ? [rule] : []
      })
      if (effects.some((rule) => rule.effect === "deny")) return { effect: "deny" as const, defaulted: false }
      if (effects.length === 0) return { effect: undefined, defaulted: false }
      // `defaulted`: every ask came from the built-in default, none from a rule the person or a project wrote.
      return { effect: "ask" as const, defaulted: effects.every((rule) => Agent.isDefaultAsk(rule)) }
    }

    function anyDenied(
      input: Pick<AssertInput, "action" | "resources" | "aliases" | "escaped" | "leads">,
      rules: Permission.Ruleset,
    ) {
      return input.resources.some((resource) => decide(input, resource, rules).effect === "deny")
    }

    function relevant(input: AssertInput, rules: Permission.Ruleset) {
      return rules.filter((rule) => actionMatches(input.action, rule.action))
    }

    const evaluateInput = Effect.fnUntraced(function* (input: AssertInput) {
      const current = managed.current()
      const only = current.restrictions.managed_permissions_only === true
      const configuredRules = yield* configured(input.sessionID, input.agent)
      const rules = configuredRules.rules
      if (anyDenied(input, rules)) return { effect: "deny" as const, rules }
      // Saved approvals are grants; managed_permissions_only ignores every one of them.
      const approvals = only ? [] : yield* savedRules()
      const all = [...rules, ...approvals]
      const decisions = input.resources.map((resource) => decide(input, resource, rules, approvals))
      const effect: Permission.Effect = decisions.some((rule) => rule.effect === "ask") ? "ask" : "allow"
      // An ask that a rule wrote (yours, the project's, an agent's built-in `.env` ask) is explicit, and so is a lead onto
      // such a rule (a grant's lead onto the person's ask). A lead onto the built-in default ask is not.
      // The built-in `external_directory * ask` of every agent is the default question, so it counts like the fallthrough.
      const explicit = decisions.some(
        (rule) => rule.effect === "ask" && !isFallthrough(rule) && !Agent.isDefaultAsk(rule),
      )
      const event = yield* hooks.trigger("permission", "evaluate", {
        sessionID: input.sessionID,
        agent: input.agent,
        action: input.action,
        resources: input.resources,
        aliases: input.aliases,
        metadata: input.metadata,
        source: input.source,
        effect,
      })
      // The managed layer runs last and in core, so no plugin hook (nor a later classifier) can override it. Order:
      // configured deny > managed rule > plugin hooks > grants and config rules > default ask.
      const layer = [
        ...current.rules,
        ...(configuredRules.agent === undefined ? [] : (current.agentRules[configuredRules.agent] ?? [])),
      ]
      const decided = input.resources.map((resource) => managedEffect(input, resource, layer))
      const blocked =
        current.organization === undefined
          ? "Blocked by managed settings"
          : `Blocked by ${current.organization}'s managed settings`
      // denied_domains binds every URL-bearing action and beats grants, config allows and hook allows. Only the deny list
      // does: allowed_domains and allow_managed_domains_only govern the shell sandbox, never a fetch.
      if (
        ManagedNetwork.bearsUrl(input.action) &&
        ManagedNetwork.denies(current.restrictions.network?.denied_domains ?? [], input.resources)
      )
        return { effect: "deny" as const, message: blocked, rules: [...all, ...layer] }
      if (decided.includes("deny")) return { effect: "deny" as const, message: blocked, rules: [...all, ...layer] }
      // A managed ask tightens an allow, never a hook's deny.
      if (decided.includes("ask"))
        return {
          effect: event.effect === "deny" ? ("deny" as const) : ("ask" as const),
          message: event.message,
          rules: all,
        }
      // A managed allow lifts only the default ask that no rule spoke to. It never undoes an ask that a rule or a plugin
      // hook gave (the hook left `effect` as it was handed it, or it is not lifted), nor a hook's deny, and it does not
      // decide a place that a link in an untrusted project leads out to. Only a managed ask or deny overrides those.
      const lifted =
        event.effect === "ask" &&
        effect === "ask" &&
        !explicit &&
        decided.length > 0 &&
        decided.every((effect, index) => effect === "allow" && !input.escaped?.includes(input.resources[index]!))
      return { effect: lifted ? ("allow" as const) : event.effect, message: event.message, rules: all }
    })

    const denied = Effect.fn("Permission.denied")(function* (input: AssertInput) {
      if (closed) return false
      const current = managed.current()
      const configuredRules = yield* configured(input.sessionID, input.agent)
      const decisive = input.probe
        ? configuredRules.rules.filter((rule) => !Agent.isModeRule(rule))
        : configuredRules.rules
      if (anyDenied(input, decisive)) return true
      if (
        ManagedNetwork.bearsUrl(input.action) &&
        ManagedNetwork.denies(current.restrictions.network?.denied_domains ?? [], input.resources)
      )
        return true
      const layer = [
        ...current.rules,
        ...(configuredRules.agent === undefined ? [] : (current.agentRules[configuredRules.agent] ?? [])),
      ]
      return input.resources.some((resource) => managedEffect(input, resource, layer) === "deny")
    })

    function request(input: AssertInput, message?: string): Request {
      return {
        id: input.id ?? ID.create(),
        sessionID: input.sessionID,
        action: input.action,
        resources: input.resources,
        // An "always" reply would save a grant, and managed_permissions_only ignores grants, so it offers none.
        save: managed.current().restrictions.managed_permissions_only ? undefined : input.save,
        metadata: input.metadata,
        source: input.source,
        message,
      }
    }

    const create = (request: Request, input: Pick<AssertInput, "agent" | "aliases" | "escaped" | "leads">) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const deferred = yield* Deferred.make<void, DeclinedError | CorrectedError>()
          const item: Pending = {
            request,
            agent: input.agent,
            aliases: input.aliases,
            escaped: input.escaped,
            leads: input.leads,
            deferred,
            call: yield* ToolCurrentCall.Current,
          }
          if (closed) {
            yield* Deferred.fail(deferred, new DeclinedError())
            return item
          }
          if (pending.has(request.id))
            return yield* Effect.die(new Error(`Duplicate pending permission ID: ${request.id}`))
          pending.set(request.id, item)
          yield* bus
            .publish(Permission.Event.Asked, request)
            .pipe(Effect.onError(() => Effect.sync(() => pending.delete(request.id))))
          return item
        }),
      )

    const ask = Effect.fn("Permission.ask")(function* (input: AssertInput) {
      if (closed) return { id: input.id ?? ID.create(), effect: "deny" as const }
      const result = yield* evaluateInput(input)
      const value = request(input, result.message)
      if (result.effect === "ask") yield* create(value, input)
      return { id: value.id, effect: result.effect }
    })

    const assert = Effect.fn("Permission.assert")((input: AssertInput) =>
      Effect.gen(function* () {
        if (closed) return yield* Effect.die(new DeclinedError())
        const result = yield* evaluateInput(input)
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            if (result.effect === "deny") {
              return yield* new BlockedError({
                rules: relevant(input, result.rules),
                permission: input.action,
                resources: input.resources,
                reason: result.message,
              })
            }
            if (result.effect === "allow") return
            const item = yield* create(request(input, result.message), input)
            return yield* restore(Deferred.await(item.deferred)).pipe(
              // Deliberate defect tunnel: leaves wrap execution in blanket `mapError`, which
              // must not convert a user's decline into model-facing tool output. The decline
              // resurfaces as a typed failure at SessionModelRequest.executeTool. A decline
              // WITH feedback (CorrectedError) intentionally stays typed so the leaf can turn
              // it into ToolFailure and the model continues.
              Effect.catchTag("Permission.DeclinedError", (error) => Effect.die(error)),
              // A prompt whose waiter is interrupted (a cancelled call, an interrupted step) is closed for clients
              // the way `close` closes it, so none is left showing a stale question.
              Effect.onExit((exit) =>
                Exit.hasInterrupts(exit) && pending.has(item.request.id)
                  ? bus.publish(Permission.Event.Replied, {
                      sessionID: item.request.sessionID,
                      requestID: item.request.id,
                      reply: "reject",
                    })
                  : Effect.void,
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  pending.delete(item.request.id)
                }),
              ),
            )
          }),
        )
      }),
    )

    const reply = Effect.fn("Permission.reply")((input: ReplyInput) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
          yield* bus.publish(Permission.Event.Replied, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
            reply: input.reply,
          })

          if (input.reply === "reject") {
            yield* Deferred.fail(
              existing.deferred,
              input.message ? new CorrectedError({ feedback: input.message }) : new DeclinedError(),
            )
            pending.delete(input.requestID)
            for (const [id, item] of pending) {
              if (item.request.sessionID !== existing.request.sessionID) continue
              yield* bus.publish(Permission.Event.Replied, {
                sessionID: item.request.sessionID,
                requestID: item.request.id,
                reply: "reject",
              })
              // Feedback applies to the whole batch, so parallel asks don't end the step.
              yield* Deferred.fail(
                item.deferred,
                input.message ? new CorrectedError({ feedback: input.message }) : new DeclinedError(),
              )
              pending.delete(id)
            }
            return
          }

          // Under managed_permissions_only an "always" reply acts as "once": nothing is saved and no other ask is lifted.
          const always = input.reply === "always" && !managed.current().restrictions.managed_permissions_only
          if (always && existing.request.save?.length) {
            yield* saved.add({
              projectID: location.project.id,
              action: existing.request.action,
              resources: existing.request.save,
            })
          }
          yield* Deferred.succeed(existing.deferred, undefined)
          pending.delete(input.requestID)
          if (!always || !existing.request.save?.length) return

          for (const [id, item] of pending) {
            const result = yield* evaluateInput({
              ...item.request,
              agent: item.agent,
              aliases: item.aliases,
              escaped: item.escaped,
              leads: item.leads,
            }).pipe(Effect.catchTag("Session.NotFoundError", () => Effect.undefined))
            if (result?.effect !== "allow") continue
            yield* bus.publish(Permission.Event.Replied, {
              sessionID: item.request.sessionID,
              requestID: item.request.id,
              reply: "always",
            })
            yield* Deferred.succeed(item.deferred, undefined)
            pending.delete(id)
          }
        }),
      ),
    )

    const list = Effect.fn("Permission.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    const get = Effect.fn("Permission.get")(function* (id: ID) {
      return pending.get(id)?.request
    })

    const forSession = Effect.fn("Permission.forSession")(function* (sessionID: SessionSchema.ID) {
      return Array.from(pending.values(), (item) => item.request).filter((request) => request.sessionID === sessionID)
    })

    const callOf = Effect.fn("Permission.callOf")(function* (id: ID) {
      return pending.get(id)?.call
    })

    return Service.of({ ask, assert, denied, reply, get, forSession, list, callOf, close })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Bus.node,
    Location.node,
    Agent.node,
    SessionStore.node,
    PermissionSaved.node,
    PluginHooks.node,
    ManagedPolicy.node,
    Global.node,
    FSUtil.node,
  ],
})
