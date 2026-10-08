import { expect, test } from "bun:test"
import path from "node:path"

// What the manifest and the source say about the doors into the extension: which settings a workspace can set, which
// commands start work, and which functions start programs and sessions. A new setting, command or door fails here until
// it has a decision, because the repository a person opens chooses its files, and the extension runs with their rights.
const root = path.join(import.meta.dir, "..")
const manifest = await Bun.file(path.join(root, "package.json")).json()

test("a workspace cannot set orbit.executable, which chooses the program the extension runs", () => {
  const setting = manifest.contributes.configuration.properties["orbit.executable"]

  // Machine scope: user settings, or the remote machine's, and never the settings of a workspace or a folder.
  expect(setting.scope).toBe("machine")
  expect(setting.markdownDescription).toContain("a workspace cannot set this")
})

test("every setting the extension contributes has a decision on who may set it", () => {
  const decisions: Record<string, string> = {
    "orbit.executable": "machine: the program the extension runs and the terminal starts",
    "orbit.placement": "window: where the chat opens, which runs and chooses nothing",
  }
  const properties = manifest.contributes.configuration.properties

  expect(Object.keys(properties).sort()).toEqual(Object.keys(decisions).sort())
  // Only a setting that chooses nothing to run keeps the scope that a workspace may set.
  for (const [key, setting] of Object.entries<{ scope?: string; default: string }>(properties))
    if (key !== "orbit.placement") expect({ key, scope: setting.scope }).toEqual({ key, scope: "machine" })
})

test("the extension stays off in a workspace that VS Code does not trust", () => {
  const capability = manifest.capabilities.untrustedWorkspaces

  expect(capability.supported).toBe(false)
  expect(capability.description).toContain("trust the workspace in VS Code")
  expect(capability.description).toContain("separately")
})

test("every command the extension contributes says what stands between it and work in an untrusted folder", () => {
  const gates: Record<string, string> = {
    "orbit.open": "starts nothing: opens the chat",
    "orbit.newSession": "starts nothing: clears the chat",
    "orbit.history": "starts nothing: lists this folder's sessions and replays one",
    "orbit.outputStyle": "starts nothing: writes the output style of the user's own config",
    "orbit.askSelection": "sends a prompt: Controller.send asks about trust first",
    "orbit.explainSelection": "sends a prompt: Controller.send asks about trust first",
    "orbit.fixDiagnostics": "sends a prompt: Controller.send asks about trust first",
    "orbit.trust": "asks whether to trust the folder: Controller.review, which is the question itself",
    "orbit.openTerminal": "starts the terminal UI, which asks about trust in its own process",
    "orbit.runs.refresh": "starts orb flow ls, which reads the run store as untrusted text",
    "orbit.runs.clean": "starts orb flow clean, which acts only on run names of one plain shape",
    "orbit.runs.approve": "starts orb flow approve, which records a decision and runs nothing",
    "orbit.runs.reject": "starts orb flow approve --reject, which records a decision and runs nothing",
    "orbit.runs.resume": "starts orb flow resume in a terminal, which refuses an untrusted folder itself",
    "orbit.runs.watch": "starts orb flow watch in a terminal, which only reads",
  }
  const contributed: string[] = manifest.contributes.commands.map((item: { command: string }) => item.command)

  expect(contributed.sort()).toEqual(Object.keys(gates).sort())
})

test("a program is started in one place, and a session only by Controller.send", async () => {
  const sources = new Map<string, string>()
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: path.join(root, "src") }))
    sources.set(file.replaceAll("\\", "/"), await Bun.file(path.join(root, "src", file)).text())
  const where = (pattern: RegExp) =>
    [...sources]
      .filter(([, text]) => pattern.test(text))
      .map(([file]) => file)
      .sort()

  // Every way to start a process from the extension host: it goes through `launch`, which finds the program on PATH.
  expect(where(/\bchild_process\b/)).toEqual(["program.ts"])
  expect(where(/\b(?:execFile|execFileSync|exec|execSync|spawn|spawnSync|fork)\s*\(/)).toEqual(["program.ts"])
  // A terminal runs a program too. Both callers start the one `find` returned and type no command into a shell.
  expect(where(/\bcreateTerminal\s*\(/)).toEqual(["extension.ts", "runs-view.ts"])
  expect(where(/\bsendText\s*\(/)).toEqual([])
  for (const file of ["extension.ts", "runs-view.ts"]) {
    const text = sources.get(file) ?? ""
    expect({ file, terminals: text.match(/\bcreateTerminal\s*\(/g)?.length }).toEqual({
      file,
      terminals: text.match(/shellPath:\s*program\b/g)?.length,
    })
  }
  // A session is made and a prompt sent only in the controller, and its `send` asks about trust before it does either.
  expect(where(/\bsession\s*\.\s*(?:create|prompt)\s*\(/)).toEqual(["controller.ts"])
  const controller = sources.get("controller.ts") ?? ""
  const send = controller.slice(controller.indexOf("async send("))
  expect(send.indexOf("await this.gate()")).toBeGreaterThan(-1)
  expect(send.indexOf("await this.gate()")).toBeLessThan(send.indexOf("await this.create()"))
  expect(send.indexOf("await this.gate()")).toBeLessThan(send.indexOf("session.prompt("))
})
