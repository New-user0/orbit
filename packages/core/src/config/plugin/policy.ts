export * as ConfigPolicyPlugin from "./policy.js"

import { define } from "@orbit/plugin/effect/plugin"
import { Document, type Scope } from "@orbit/schema/config"
import { Effect } from "effect"
import { Config } from "../../config.js"
import { ManagedPolicy } from "../../managed-policy.js"
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
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, ctx.provider.reload())
    // Authored documents are ordered by scope rank; the stable sort keeps the reversed config order inside a scope,
    // so an outer document still outranks an inner one. A document without a scope counts as user. Organization
    // statements from the connected Console follow every authored one and have the final say.
    const policies = () => {
      const organization = managed.current()
      return [
        ...loaded.entries
          .filter((entry): entry is Document => entry.type === "document")
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
    yield* ctx.permission.hook("evaluate", (event) =>
      Effect.sync(() => {
        const current = policies()
        // Like Permission.evaluate, a resource and its aliases are one subject:
        // the last policy matching any of its spellings decides.
        const denied = event.resources
          .map((resource) => {
            const subjects = [resource, ...(event.aliases ?? [])].map((spelling) => `${event.action}:${spelling}`)
            return current.findLast(
              (policy) =>
                policy.action === "permission" && subjects.some((subject) => Wildcard.match(subject, policy.resource)),
            )
          })
          .find((policy) => policy?.effect === "deny")
        if (!denied) return
        event.effect = "deny"
        event.message = denied.message
      }),
    )
  }),
})
