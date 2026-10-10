// Records PowerShell's own answer for every text in powershell-cases.ts: `bun test/shell-analysis/record-powershell.ts`
// from packages/core. The tests feed the stored output to PowerShellParse.interpret, so they need no PowerShell.
import path from "node:path"
import { PowerShellParse } from "../../src/shell/powershell-parse"
import { which } from "../../src/util/which"
import { notReadOnly, platform, readOnly } from "./powershell-cases"

const host = which("pwsh") ?? which("powershell")
if (!host) throw new Error("no pwsh or powershell on PATH")
const rows = Object.fromEntries(
  await Promise.all(
    [...new Set([...readOnly, ...notReadOnly, ...platform])].map(async (text) => {
      const script = PowerShellParse.SCRIPT.replace("__TEXT__", Buffer.from(text, "utf8").toString("base64"))
      const child = Bun.spawn(
        [host, "-NoProfile", "-NonInteractive", "-NoLogo", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { stdout: "pipe", stderr: "ignore", stdin: "ignore", cwd: process.env.TEMP ?? "/tmp" },
      )
      const output = await new Response(child.stdout).text()
      return [text, { code: await child.exited, output }] as const
    }),
  ),
)
await Bun.write(path.join(import.meta.dir, "powershell.json"), JSON.stringify(rows, null, 1) + "\n")
console.log(`recorded ${Object.keys(rows).length} texts with ${host}`)
