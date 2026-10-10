import { Effect } from "effect"
import { PowerShellParse } from "./powershell-parse.js"

// PowerShell structure for the permission layers, taken from PowerShell's own parser (see powershell-parse.ts). Unlike
// ShellScan.inspect for Bash this runs a host process, so it is an Effect: parse first, then hand the summary to the
// pure analysis. Scanned means the parse was clean; every other outcome is opaque with the parser's reason, and opaque
// always means ask. Nothing here decides that a command is allowed.
export type Inspection =
  | { kind: "scanned"; summary: PowerShellParse.Summary }
  | { kind: "opaque"; reason: PowerShellParse.Reason }

export const inspect = Effect.fn("PowerShellInspect.inspect")(function* (text: string) {
  const parser = yield* PowerShellParse.Service
  const result = yield* parser.parse(text)
  if (!result.valid) return { kind: "opaque", reason: result.reason } satisfies Inspection
  return { kind: "scanned", summary: result.summary } satisfies Inspection
})

export * as PowerShellInspect from "./powershell-inspect.js"
