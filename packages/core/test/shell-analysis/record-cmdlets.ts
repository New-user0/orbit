// Records the parameters of every cmdlet in the path table from a PowerShell host: `bun test/shell-analysis/record-cmdlets.ts
// <win51|linux7>` from packages/core. Per cmdlet it stores each parameter's name, aliases, whether it is a switch, and its
// positions in the parameter sets. The tests compare the table in src/shell/paths.ts with the stored answers. The script
// reads command metadata only; it runs nothing from a project.
import path from "node:path"

const names =
  "Set-Content Add-Content Clear-Content Remove-Item Out-File Tee-Object Export-Csv Export-Clixml New-Item Copy-Item Move-Item Rename-Item Set-Item Clear-Item Set-ItemProperty New-ItemProperty Remove-ItemProperty Export-Alias Expand-Archive Compress-Archive Invoke-WebRequest Invoke-RestMethod Set-Location Push-Location Pop-Location New-PSDrive"
const which = process.argv[2]
if (which !== "win51" && which !== "linux7") throw new Error("usage: record-cmdlets.ts <win51|linux7>")
const script = `
$ErrorActionPreference = 'SilentlyContinue'
$out = @()
foreach ($name in '${names}'.Split(' ')) {
  $c = Get-Command -Name $name -CommandType Cmdlet,Function | Select-Object -First 1
  if (-not $c) { continue }
  $params = @()
  foreach ($p in $c.Parameters.Values) {
    $pos = @($p.ParameterSets.Values | ForEach-Object { $_.Position } | Where-Object { $_ -ge 0 } | Sort-Object -Unique)
    $params += [ordered]@{ name = $p.Name; aliases = @($p.Aliases); switch = [bool]($p.ParameterType -eq [System.Management.Automation.SwitchParameter]); positions = @($pos) }
  }
  $out += [ordered]@{ cmdlet = $c.Name; parameters = @($params) }
}
$mk = @('mkdir', 'md') | ForEach-Object { $g = Get-Command -Name $_ | Select-Object -First 1; if ($g) { [ordered]@{ name = $_; type = [string]$g.CommandType } } }
[ordered]@{ version = $PSVersionTable.PSVersion.ToString(); cmdlets = @($out); kinds = @($mk) } | ConvertTo-Json -Depth 8 -Compress
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
// PowerShell 5.1 collapses a one-element array to the element and an empty one to nothing.
const many = <T,>(value: T | T[] | null | undefined): T[] => (value === null || value === undefined ? [] : Array.isArray(value) ? value : [value])
const normal = {
  version: parsed.version,
  kinds: many<{ name: string; type: string }>(parsed.kinds),
  cmdlets: many<any>(parsed.cmdlets).map((item) => ({
    cmdlet: item.cmdlet,
    parameters: many<any>(item.parameters).map((param) => ({
      name: param.name,
      aliases: many<string>(param.aliases),
      switch: param.switch,
      positions: many<number>(param.positions),
    })),
  })),
}
await Bun.write(path.join(import.meta.dir, `cmdlets-${which}.json`), JSON.stringify(normal, null, 1) + "\n")
console.log(`recorded ${normal.cmdlets.length} cmdlets from ${which} (${normal.version})`)
