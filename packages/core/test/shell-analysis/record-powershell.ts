// Records PowerShell's own answer for every text in powershell-cases.ts. From packages/core:
//   bun test/shell-analysis/record-powershell.ts          the local Windows PowerShell (or pwsh) -> powershell.json
//   bun test/shell-analysis/record-powershell.ts linux7   pwsh 7 in the orbit-linux-test-pwsh image -> powershell-7.json
// The tests feed the stored output to PowerShellParse.interpret, so they need no PowerShell.
import path from "node:path"
import { PowerShellParse } from "../../src/shell/powershell-parse"
import { which } from "../../src/util/which"
import { pathCases } from "./path-cases"
import { arrayAndNetwork, arrayAndNetworkOk, chain, notReadOnly, platform, readOnly, toolNotReadOnly, toolPlatform, toolReadOnly } from "./powershell-cases"

const seven = process.argv[2] === "linux7"
const host = seven ? undefined : (which("pwsh") ?? which("powershell"))
if (!seven && !host) throw new Error("no pwsh or powershell on PATH")
const texts = seven ? [...new Set([...chain, ...toolPlatform, ...pathCases])] : [...new Set([...readOnly, ...notReadOnly, ...platform, ...arrayAndNetwork, ...arrayAndNetworkOk, ...toolReadOnly, ...toolNotReadOnly, ...toolPlatform, ...pathCases])]
const rows = Object.fromEntries(
  await Promise.all(
    texts.map(async (text) => {
      const script = PowerShellParse.SCRIPT.replace("__TEXT__", Buffer.from(text, "utf8").toString("base64"))
      const flags = ["-NoProfile", "-NonInteractive", "-NoLogo", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]
      const child = Bun.spawn(seven ? ["docker", "run", "--rm", "orbit-linux-test-pwsh", "pwsh", ...flags] : [host!, ...flags], {
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
        cwd: process.env.TEMP ?? "/tmp",
      })
      const output = await new Response(child.stdout).text()
      return [text, { code: await child.exited, output }] as const
    }),
  ),
)
await Bun.write(path.join(import.meta.dir, seven ? "powershell-7.json" : "powershell.json"), JSON.stringify(rows, null, 1) + "\n")
console.log(`recorded ${Object.keys(rows).length} texts with ${seven ? "pwsh 7 (Docker)" : host}`)
