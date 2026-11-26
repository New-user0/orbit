import { createEffect } from "solid-js"
import { expect, test } from "bun:test"
import path from "node:path"
import { Plugin } from "@orbit/plugin/tui"
import { builtins } from "../src/plugin/builtins"
import { createAppFixture, promptReady } from "./fixture/app"
import { listedNames, problems, slashParity, type Registered } from "./fixture/slash-parity"
import { directory, json } from "./fixture/tui-client"

// Every slash command that the TUI registers is on the list of built-ins, and every built-in the list says is present is
// registered. The commands come from two places: the keymap of the running app at a session route, which holds what is
// reachable there, and the source, which also holds the commands that only appear in some state (redo, unshare, trust,
// restart, update and terminal).

const location = { directory, project: { id: "project", directory, canonical: directory } }
const session = {
  id: "ses_parity",
  title: "Parity",
  projectID: "project",
  location: { directory },
  agent: "build",
  model: { providerID: "provider", id: "model" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

async function reachable() {
  const found: { name: string; aliases: string[] }[] = []
  // The app starts the built-in plugins, so a probe among them can read the keymap from inside the running app.
  const probe = Plugin.define({
    id: "test.slash-probe",
    setup(context) {
      context.ui.slot({
        append: "app",
        render() {
          createEffect(() => {
            found.length = 0
            for (const command of context.keymap.commands())
              if (command.slash) found.push({ name: command.slash.name, aliases: [...(command.slash.aliases ?? [])] })
          })
          return null
        },
      })
    },
  })
  builtins.push(probe as never)
  try {
    await using setup = await createAppFixture({
      args: { sessionID: session.id },
      config: { animations: false },
      fetch: (url) => {
        if (url.pathname === "/api/fs/list") return json({ location, data: [] })
        if (url.pathname === "/api/location") return json(location)
        if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
        if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
        if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
          return json({ data: [], cursor: {} })
        if (url.pathname === "/api/agent")
          return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
        if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
        if (url.pathname === "/api/model")
          return json({
            location,
            data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }],
          })
      },
    })
    await setup.waitForFrame((frame) => promptReady(frame))
    for (let attempt = 0; attempt < 100 && found.length === 0; attempt++) await Bun.sleep(20)
    await Bun.sleep(200)
    return found.slice()
  } finally {
    builtins.splice(builtins.indexOf(probe as never), 1)
  }
}

/** Every `slash: { name, aliases }` in the source, including the ones written over several lines. */
async function declared() {
  const found: { name: string; aliases: string[] }[] = []
  const pattern = /slash:\s*\{\s*name:\s*"([^"]+)"(?:\s*,\s*aliases:\s*\[([^\]]*)\])?/g
  for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan(path.join(import.meta.dir, "../src"))) {
    if (file.includes("storybook")) continue
    const text = await Bun.file(path.join(import.meta.dir, "../src", file)).text()
    for (const match of text.matchAll(pattern))
      found.push({
        name: match[1]!,
        aliases: [...(match[2] ?? "").matchAll(/"([^"]+)"/g)].map((alias) => alias[1]!),
      })
  }
  return found
}

const registered = (commands: readonly { name: string; aliases: string[] }[]): Registered => ({
  names: new Set(commands.flatMap((command) => [command.name, ...command.aliases])),
  claims: commands.flatMap((command) => [command.name, ...command.aliases]),
})

test("the commands the running app reaches, and the ones the source declares, agree with the list of built-ins", async () => {
  const live = await reachable()
  // The control: the probe saw the app's commands, among them ones from every place that registers them.
  const liveNames = registered(live).names
  for (const name of ["agents", "ide", "vim", "terminal-setup", "todos", "diff", "btw", "stats", "plugins", "fork", "share"])
    expect(liveNames.has(name)).toBe(true)

  // What is reachable is listed. A listed command that is not reachable here is one that appears only in some state.
  const unreachable = problems(registered(live)).filter((problem) => problem.includes("is listed as present but"))
  expect(problems(registered(live)).filter((problem) => !unreachable.includes(problem))).toEqual([])
  // `terminal` is reachable only where the terminal pane exists, which depends on the platform.
  const stateful = unreachable.map((problem) => problem.split(" ")[0]!)
  for (const name of ["redo", "restart", "trust", "unshare", "update"]) expect(stateful).toContain(name)
  for (const name of stateful) expect(["redo", "restart", "terminal", "trust", "unshare", "update"]).toContain(name)
  const source = registered(await declared())
  expect(problems(source)).toEqual([])
  // Whatever is reachable is declared, so nothing is registered that the source scan cannot see.
  for (const name of liveNames) expect(source.names.has(name)).toBe(true)
}, 30_000)

test("the aliases this task adds open the same commands as the longer names", async () => {
  const commands = registered(await declared())
  for (const alias of ["model", "mcp", "config", "plugin", "ide", "vim", "terminal-setup", "todos"])
    expect(commands.names.has(alias)).toBe(true)
  const named = (await declared()).find((command) => command.name === "models")
  expect(named?.aliases).toContain("model")
})

// Each kind of disagreement is found: the checks are the same function the test above runs on the real commands.
const base = registered([
  { name: "agents", aliases: [] },
  { name: "sessions", aliases: ["resume", "continue"] },
])
const small = slashParity.filter((entry) =>
  entry.state === "present" ? ["agents", "resume", "continue", "sessions"].includes(entry.name) : entry.name === "pr-comments",
)

test("an agreeing small list has no problems", () => {
  expect(problems(base, small)).toEqual([])
})

test("an alias that is dropped leaves a present entry unresolved", () => {
  const dropped = registered([
    { name: "agents", aliases: [] },
    { name: "sessions", aliases: ["continue"] },
  ])
  expect(problems(dropped, small)).toEqual(["resume is listed as present but nothing registers resume"])
})

test("a command that is registered and not listed is reported", () => {
  const extra = registered([
    { name: "agents", aliases: [] },
    { name: "sessions", aliases: ["resume", "continue"] },
    { name: "surprise", aliases: [] },
  ])
  expect(problems(extra, small)).toEqual(["surprise is registered but not listed"])
})

test("a pending entry that is already registered is reported", () => {
  const early = registered([
    { name: "agents", aliases: [] },
    { name: "sessions", aliases: ["resume", "continue"] },
    { name: "pr-comments", aliases: [] },
  ])
  expect(problems(early, small)).toEqual([
    "pr-comments is registered but not listed",
    "pr-comments is pending (agents-extensibility-41) but already registered",
  ])
})

test("two commands that claim one name are reported", () => {
  const twice = registered([
    { name: "agents", aliases: [] },
    { name: "sessions", aliases: ["resume", "continue"] },
    { name: "other", aliases: ["agents"] },
  ])
  expect(problems(twice, small)).toContain("agents is claimed by more than one command")
})

test("an alias equal to another command's name is a claim by two", () => {
  expect(problems(registered([{ name: "a", aliases: ["b"] }, { name: "b", aliases: [] }]), [])).toContain(
    "b is claimed by more than one command",
  )
})

test("every name on the list is unique", () => {
  const names = slashParity.map((entry) => entry.name)
  expect(new Set(names).size).toBe(names.length)
  const served = slashParity.flatMap((entry) => (entry.state === "present" ? entry.slash : []))
  expect(new Set(served).size).toBe(served.length)
  expect(listedNames().size).toBe(served.length)
})
