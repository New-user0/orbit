import { expect, test } from "bun:test"
import { CrossSpawnSpawner } from "@orbit/util/cross-spawn-spawner"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Effect, Layer } from "effect"
import { ShellAnalysis } from "../../src/shell/analysis"
import { PowerShellParse } from "../../src/shell/powershell-parse"
import { which } from "../../src/util/which"
import { powershell, pwsh } from "./helper"

// A small subset against a real PowerShell, so the recorded answers cannot drift from what the parser says now.
// Skipped when no host is installed; the rest of the suite reads the recorded answers.
const hasHost = Boolean(which("pwsh") ?? (process.platform === "win32" ? which("powershell") : null))
const real = Layer.provide(PowerShellParse.layerWith(), LayerNode.compile(CrossSpawnSpawner.node))

const rows: Array<[string, boolean]> = [
  ["Get-ChildItem -Recurse -Filter *.ts", true],
  ["Get-Content a -Tail 5", true],
  ["Get-Process | Select-Object Name, Id", true],
  ["Get-ChildItem > $null", true],
  ["Get-ChildItem > out.txt", false],
  ["Get-Content $env:SECRET", false],
  ["Get-ChildItem | ForEach-Object { rm $_ }", false],
  ["Get-ChildItem -Rec", false],
]

test.skipIf(!hasHost).each(rows)(
  "the real parser agrees with the recorded answer for %s",
  async (text, expected) => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const parser = yield* PowerShellParse.Service
        return yield* parser.parse(text)
      }).pipe(Effect.provide(real)),
    )
    expect(ShellAnalysis.analyze(text, pwsh(), result).readOnly).toBe(expected)
    expect(powershell(text, pwsh()).readOnly).toBe(expected)
  },
  60_000,
)
