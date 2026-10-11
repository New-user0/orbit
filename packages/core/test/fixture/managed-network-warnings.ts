import { Effect, Logger } from "effect"
import { ManagedNetwork } from "@orbit/core/managed-network"

// Runs in a child process: the "once per process" flags are module state that other test files would already have set.
const lines: string[] = []
const logger = Logger.make((entry) => {
  lines.push(String(entry.message))
})

const limited = { allowed_domains: ["example.com"] }

await Effect.runPromise(
  Effect.gen(function* () {
    // Offline: only when the user asked for network and domain settings exist.
    yield* ManagedNetwork.sandboxSettings({ network: true }, undefined)
    yield* ManagedNetwork.sandboxSettings({ network: false }, limited)
    yield* ManagedNetwork.sandboxSettings({ network: true }, limited)
    yield* ManagedNetwork.sandboxSettings({ network: true }, limited)
    // Unbound: only when settings exist, and once.
    yield* ManagedNetwork.unbound(undefined)
    yield* ManagedNetwork.unbound(limited)
    yield* ManagedNetwork.unbound(limited)
  }).pipe(Effect.provide(Logger.layer([logger]))),
)

console.log(JSON.stringify(lines))
