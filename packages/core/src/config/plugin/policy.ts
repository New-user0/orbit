export * as ConfigPolicyPlugin from "./policy.js"

import { define } from "@orbit/plugin/effect/plugin"
import { Document, type Scope } from "@orbit/schema/config"
import { Effect } from "effect"
import { Config } from "../../config.js"
import { ManagedPolicy } from "../../managed-policy.js"
import { PermissionPolicy } from "../../permission/policy.js"
import { ToolNames } from "../../tool/names.js"
import { Wildcard } from "../../util/wildcard.js"
import { ConfigEntryObserver } from "./entry-observer.js"

// Authority from lowest to highest; the last matching statement decides. Files a repository carries rank lowest,
// flags outrank them, the user's own config outranks both, and organization-supplied documents (remote, managed)
// outrank the user.
const rank = { project: 0, local: 1, flag: 2, user: 3, remote: 4, managed: 5 } satisfies Record<Scope, number>

export const Plugin = define({
  id: "orbit.config.policy",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const managed = yield* ManagedPolicy.Service
    const permissionPolicy = yield* PermissionPolicy.Service
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, ctx.provider.reload())
    // Authored documents are ordered by scope rank; the stable sort keeps the reversed config order inside a scope,
    // so an outer document still outranks an inner one. A document without a scope counts as user. Organization
    // statements from the connected Console follow every authored one and have the final say.
    const policies = () => {
      const organization = managed.current()
      return [
        ...loaded.entries
          // A managed document's statements arrive through ManagedPolicy, so ranking it here would count them twice.
          .filter((entry): entry is Document => entry.type === "document" && entry.scope !== "managed")
          .toReversed()
          .toSorted((a, b) => rank[a.scope ?? "user"] - rank[b.scope ?? "user"])
          .flatMap((entry) => entry.info.experimental?.policies ?? [])
          .map((policy) => ({ ...policy, message: "Blocked by configuration policy" })),
        ...organization.statements.map((policy) => ({
          ...policy,
          message: organization.organization
            ? `Blocked by ${organization.organization}'s policy`
            : "Blocked by your organization's policy",
        })),
      ]
    }
    yield* ctx.provider.transform((providers) => {
      const current = policies()
      for (const record of providers.list()) {
        const policy = current.findLast(
          (policy) => policy.action === "provider.use" && Wildcard.match(record.provider.id, policy.resource),
        )
        if (policy?.effect === "deny") providers.remove(record.provider.id)
      }
    })
    const refusal = (subject: PermissionPolicy.Subject) => {
      const current = policies()
      // Like Permission.evaluate, a resource and its own aliases are one subject:
      // the last policy matching any of its spellings decides.
      // A policy written with an old tool name (`shell:rm *`) still names the same action as `Bash:rm *`.
      const decide = (spellings: ReadonlyArray<string>) => {
        const subjects = ToolNames.spellings(subject.action).flatMap((action) =>
          spellings.map((spelling) => `${action}:${spelling}`),
        )
        return current.findLast(
          (policy) =>
            policy.action === "permission" && subjects.some((item) => Wildcard.match(item, policy.resource)),
        )
      }
      // The places a resource leads to through a link are a separate pass that can only refuse, as Permission tries
      // them: merged into the aliases, an allow written for a lead's spelling would lift a deny of the resource. A
      // policy for the path as an untrusted project spells it meets the call here, since its resource is the real
      // place the link leads to (class 3). The spellings of one place are one subject, as for a rule, so a later allow
      // for the project's spelling of a place lifts a broad deny of it, while a second place is decided on its own.
      return subject.resources
        .flatMap((resource) => [
          decide([resource, ...(subject.aliases?.[resource] ?? [])]),
          ...(subject.leads?.[resource] ?? []).map((spellings) => decide(spellings)),
        ])
        .find((policy) => policy?.effect === "deny")?.message
    }
    // The checks that run no plugin hook (the editor field, the file-change reminder, the shell guard's probes) take the
    // same decision from here, so a policy refuses a file there as it refuses the tool (classes 3 and 8).
    yield* permissionPolicy.install(refusal)
    yield* ctx.permission.hook("evaluate", (event) =>
      Effect.sync(() => {
        const message = refusal(event)
        if (message === undefined) return
        event.effect = "deny"
        event.message = message
      }),
    )
  }),
})
