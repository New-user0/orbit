// m5-quality, item 12: the configuration policies' decision for the checks that run no plugin hook lives as long as the
// plugin that installed it. A later install (the plugin of a rebuilt Location) wins, the earlier one closing does not
// take it away, and once the last closes nothing refuses.
import { describe, expect } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { PermissionPolicy } from "@orbit/core/permission/policy"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(PermissionPolicy.node))

const subject = { action: "Read", resources: ["secret.txt"] }

describe("PermissionPolicy", () => {
  it.live("refuses by the newest install while it is open, and by none once every install is closed", () =>
    Effect.gen(function* () {
      const policy = yield* PermissionPolicy.Service
      expect(policy.refuses(subject)).toBeUndefined()
      const first = yield* Scope.make()
      const second = yield* Scope.make()
      yield* policy.install(() => "first").pipe(Scope.provide(first))
      expect(policy.refuses(subject)).toBe("first")
      yield* policy.install(() => "second").pipe(Scope.provide(second))
      expect(policy.refuses(subject)).toBe("second")
      yield* Scope.close(first, Exit.void)
      expect(policy.refuses(subject)).toBe("second")
      yield* Scope.close(second, Exit.void)
      expect(policy.refuses(subject)).toBeUndefined()
    }),
  )
})
