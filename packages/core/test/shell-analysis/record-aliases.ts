// Records what a PowerShell host says about every name in the alias table: `bun test/shell-analysis/record-aliases.ts
// <win51|linux7>` from packages/core. win51 runs the local Windows PowerShell; linux7 runs pwsh 7 in the
// orbit-linux-test-pwsh Docker image (tools/linux-test). The tests compare the table with the stored answers.
import path from "node:path"
import { ShellAnalysis } from "../../src/shell/analysis"

const which = process.argv[2]
if (which !== "win51" && which !== "linux7") throw new Error("usage: record-aliases.ts <win51|linux7>")
const script = `
$ErrorActionPreference ='SilentlyContinue'
$names = '${ShellAnalysis.aliasNames().join(" ")}'.Split(' ')
$functions = @(Get-Command -CommandType Function | Where-Object { $names -contains $_.Name } | ForEach-Object { $_.Name })
$all = Get-Alias | ForEach-Object { [pscustomobject]@{ name = $_.Name; target = $_.Definition } }
[pscustomobject]@{ version = $PSVersionTable.PSVersion.ToString(); functions = $functions; aliases = @($all) } | ConvertTo-Json -Depth 4 -Compress
`
const encoded = Buffer.from(script, "utf16le").toString("base64")
const command =
  which === "win51"
    ? ["powershell", "-NoProfile", "-NonInteractive", "-NoLogo", "-EncodedCommand", encoded]
    : ["docker", "run", "--rm", "orbit-linux-test-pwsh", "pwsh", "-NoProfile", "-NonInteractive", "-NoLogo", "-EncodedCommand", encoded]
const child = Bun.spawn(command, { stdout: "pipe", stderr: "inherit", stdin: "ignore" })
const output = await new Response(child.stdout).text()
if ((await child.exited) !== 0) throw new Error("the host failed")
const parsed = JSON.parse(output)
await Bun.write(path.join(import.meta.dir, `aliases-${which}.json`), JSON.stringify(parsed, null, 1) + "\n")
console.log(`recorded ${parsed.aliases.length} aliases from ${which} (${parsed.version})`)
