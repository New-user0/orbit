import os from "node:os"
import path from "node:path"
import { which } from "@orbit/util/which"
import { AppProcess } from "@orbit/util/process"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Effect, Logger } from "effect"
import { ChildProcess } from "effect/unstable/process"

/** How long one notification program may run before it is stopped and the attempt counts as failed. */
export const SYSTEM_NOTIFY_TIMEOUT_MS = 10_000

export type SystemCommand = {
  file: string
  args: string[]
  env?: Record<string, string>
  cwd: string
}

export type SystemRun = (command: SystemCommand, timeoutMs: number) => Promise<{ exitCode: number; stdout: string }>

// The script is a constant. The title and the message reach it only through the environment, and the toast is built
// through the XML DOM, so no value is ever read as markup or as script. ORBIT_NOTIFY_DRY makes it print the XML instead
// of showing it; only tests set that.
export const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$toast = $doc.CreateElement('toast')
[void]$doc.AppendChild($toast)
$visual = $doc.CreateElement('visual')
[void]$toast.AppendChild($visual)
$binding = $doc.CreateElement('binding')
$binding.SetAttribute('template', 'ToastGeneric')
[void]$visual.AppendChild($binding)
foreach ($value in @($env:ORBIT_NOTIFY_TITLE, $env:ORBIT_NOTIFY_MESSAGE)) {
  $text = $doc.CreateElement('text')
  [void]$text.AppendChild($doc.CreateTextNode([string]$value))
  [void]$binding.AppendChild($text)
}
if ($env:ORBIT_NOTIFY_DRY -eq '1') {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::Out.Write($doc.GetXml())
  exit 0
}
$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
$notice = New-Object Windows.UI.Notifications.ToastNotification($doc)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show($notice)
`

export const MACOS_SCRIPT = ["on run argv", "display notification (item 3 of argv) with title (item 2 of argv)", "end run"]

/**
 * The program that shows one notification, or undefined when this platform or machine has none. The title and message
 * are data: they travel as their own arguments or environment values and never become part of a script.
 */
export function systemCommand(input: {
  platform: NodeJS.Platform
  title: string
  message: string
  find: (name: string) => string | null
  home: string
}): SystemCommand | undefined {
  if (input.platform === "linux") {
    const file = input.find("notify-send")
    if (!file) return
    // Daemons read a small markup language in the body; the summary is plain text.
    const body = input.message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    return { file, args: ["--app-name=Orbit", "--", input.title, body], cwd: input.home }
  }
  if (input.platform === "darwin") {
    const file = input.find("osascript")
    if (!file) return
    // The fixed first positional ends option parsing, so a title such as -e stays an argument.
    return {
      file,
      args: [...MACOS_SCRIPT.flatMap((line) => ["-e", line]), "orbit", input.title, input.message],
      cwd: input.home,
    }
  }
  if (input.platform === "win32") {
    // Windows PowerShell 5.1 only: PowerShell 7 lacks the WinRT projection the toast API needs.
    const file = input.find("powershell")
    if (!file) return
    return {
      file,
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64"),
      ],
      env: { ORBIT_NOTIFY_TITLE: input.title, ORBIT_NOTIFY_MESSAGE: input.message },
      cwd: input.home,
    }
  }
}

/** Starts the program through the spawner of Orbit, which keeps Windows from looking in the working folder. */
export const runSystemCommand: SystemRun = (command, timeoutMs) =>
  Effect.gen(function* () {
    const processes = yield* AppProcess.Service
    const result = yield* processes.run(
      ChildProcess.make(command.file, command.args, {
        cwd: command.cwd,
        env: command.env,
        extendEnv: true,
        stdin: "ignore",
      }),
      { timeout: timeoutMs, maxOutputBytes: 64 * 1024, maxErrorBytes: 4 * 1024 },
    )
    return { exitCode: result.exitCode, stdout: result.stdout.toString("utf8") }
  }).pipe(Effect.provide(LayerNode.compile(AppProcess.node)), Effect.provide(Logger.layer([])), Effect.runPromise)

/** True only when the program was found, started and exited with status 0 within the time limit. */
export async function notifySystem(
  input: { title: string; message: string },
  deps: { platform?: NodeJS.Platform; find?: (name: string) => string | null; run?: SystemRun; timeoutMs?: number } = {},
) {
  const command = systemCommand({
    platform: deps.platform ?? process.platform,
    title: input.title,
    message: input.message,
    find: deps.find ?? findProgram,
    home: os.homedir(),
  })
  if (!command) return false
  return (deps.run ?? runSystemCommand)(command, deps.timeoutMs ?? SYSTEM_NOTIFY_TIMEOUT_MS).then(
    (result) => result.exitCode === 0,
    (error) => {
      console.debug("failed to show system notification", { error })
      return false
    },
  )
}

// A relative PATH entry such as "." means the working folder, which is the repository Orbit was started in, so only
// absolute entries are searched.
export function findProgram(name: string) {
  const entries = (process.env.PATH ?? process.env.Path ?? "")
    .split(path.delimiter)
    .map((entry) => entry.replace(/^"(.*)"$/, "$1"))
    .filter((entry) => path.isAbsolute(entry))
  return which(name, { PATH: entries.join(path.delimiter) })
}
