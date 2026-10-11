// Runs `apply` on adversarial inputs and prints each refusal. Started by sed.test.ts in a child process with a deadline,
// because a pattern that backtracks blocks the event loop and the test runner's own timeout never fires.
import { SedScript } from "../../src/shell/sed"
import { bash } from "./helper"

const rows = [
  ["sed -i 's/.*x.*y/Z/' f", "x".repeat(20_000)],
  ["sed -i 's/a*a*a*b/Z/' f", "a".repeat(20_000)],
  ["sed -Ei 's/a+a+b/Z/' f", "a".repeat(20_000)],
  ["sed -i '/a*a*b/d' f", "a".repeat(20_000)],
]
const out = rows.map(([command, text]) => {
  const planned = SedScript.plan(bash(command), "gnu")
  if (!planned.ok) return planned.reason
  const result = SedScript.apply(text, planned.edit)
  return result.ok ? "applied" : result.reason
})
console.log(JSON.stringify(out))
