import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Global } from "@orbit/util/global"
import { Effect } from "effect"
import { ConfigOverlay } from "../src/config-overlay"
import { isolatedEnv } from "./fixture/environment"

// --settings takes a config file or the JSON itself. The value's shape decides which, never the disk (a folder can ship
// a file named after the text a person types). A file travels by path so that the references inside it resolve beside
// it; inline JSON is a layer of the run's overlay. The rows below pin each part; the end-to-end ones run `orb debug
// config` in a child process against a private server, which is what a person reaches.

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-settings-")))
const typed = path.join(root, "typed")
const opened = path.join(root, "opened")
const overlays = path.join(Global.Path.state, "overlays")

beforeAll(async () => {
  await fs.mkdir(typed, { recursive: true })
  await fs.mkdir(opened, { recursive: true })
})

afterAll(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

const build = (settings: string[], extra: Partial<Parameters<typeof ConfigOverlay.build>[0]> = {}) =>
  ConfigOverlay.build({ settings, cwd: typed, ...extra })

const refused = (settings: string[], extra: Partial<Parameters<typeof ConfigOverlay.build>[0]> = {}) =>
  build(settings, extra).then(
    () => "",
    (error: Error) => error.message,
  )

const parsed = async (settings: string[], extra: Partial<Parameters<typeof ConfigOverlay.build>[0]> = {}) => {
  const built = await build(settings, extra)
  return { file: built?.file, content: built?.content === undefined ? undefined : JSON.parse(built.content) }
}

describe("the shape decides, never the disk", () => {
  test.each([
    ['{"model":"a/b"}', true],
    ['  {"model":"a/b"}  ', true],
    ['/* c */ {"model":"a/b"}', true],
    ['// a comment\n{"model":"a/b"}', true],
    ["{}", true],
    ["s.json", false],
    ["./s.json", false],
    ["C:\\x\\s.json", false],
    ["C:/x/s.json", false],
    ["//server/share/s.json", false],
    ["[1]", false],
    ['"x"', false],
  ])("%j is inline: %p", (value, isInline) => {
    expect(ConfigOverlay.inline(value)).toBe(isInline)
  })

  test("a file named {} in the folder the command was typed in is never read for --settings {}", async () => {
    await Bun.write(path.join(typed, "{}"), '{"shell":"DECOY"}')
    try {
      expect(await parsed(["{}"])).toEqual({ file: undefined, content: {} })
      // The file is still there for the spelling that says it is a file.
      expect(await parsed(["./{}"])).toEqual({ file: await fs.realpath(path.join(typed, "{}")), content: undefined })
    } finally {
      await fs.rm(path.join(typed, "{}"), { force: true })
    }
  })
})

describe("inline JSON", () => {
  test("is a layer of the overlay, over the inherited content and under --mcp-config and --agents", async () => {
    const inherited = JSON.stringify({
      model: "inherited/x",
      shell: "inherited-shell",
      agents: { a: { system: "inh" } },
    })
    const settings = JSON.stringify({
      model: "settings/x",
      agents: { a: { system: "settings" } },
      mcp: { servers: { s: { type: "local", command: ["from-settings"] } } },
    })
    const agents = JSON.stringify({ a: { system: "agents-flag" } })
    const servers = JSON.stringify({ servers: { s: { type: "local", command: ["from-mcp-config"] } } })

    const merged = await parsed([settings], { inherited, mcpConfig: [servers], agents })
    expect(merged.content.model).toBe("settings/x")
    expect(merged.content.shell).toBe("inherited-shell")
    expect(merged.content.agents.a.system).toBe("agents-flag")
    expect(merged.content.mcp.servers.s.command).toEqual(["from-mcp-config"])
    expect((await parsed([settings], { inherited })).content.agents.a.system).toBe("settings")
    expect(merged.file).toBeUndefined()
  })

  test("permission rules add up with the inherited ones", async () => {
    const rule = (resource: string) => ({ action: "shell", resource, effect: "deny" })
    const merged = await parsed([JSON.stringify({ permissions: [rule("b")] })], {
      inherited: JSON.stringify({ permissions: [rule("a")] }),
    })
    expect(merged.content.permissions).toEqual([rule("a"), rule("b")])
  })

  test("a relative {file:} reference means the folder the command was typed in", async () => {
    await Bun.write(path.join(typed, "note.txt"), "TYPED")
    await Bun.write(path.join(opened, "note.txt"), "DECOY")
    const merged = await parsed(['{"shell":"{file:./note.txt}"}'])
    const token = /\{file:([^}]+)\}/.exec(merged.content.shell)![1]
    expect(await Bun.file(token).text()).toBe("TYPED")
  })

  test("that does not parse is refused with the flag and the offset, and no overlay is left", async () => {
    const before = await fs.readdir(overlays).catch(() => [])
    const message = await Effect.runPromise(
      ConfigOverlay.apply({ settings: ['{"model":'], server: undefined }).pipe(
        Effect.map(() => ""),
        Effect.catch((error) => Effect.succeed(error.message)),
        Effect.scoped,
      ),
    )
    expect(message).toContain("--settings: invalid JSON")
    expect(message).toMatch(/at offset \d+/)
    expect(await fs.readdir(overlays).catch(() => [])).toEqual(before)
    expect(process.env.ORBIT_CONFIG_CONTENT_FILE).toBeUndefined()
  })

  test("without a double quote it carries a hint that the shell removed them, and with one it does not", async () => {
    // What Windows PowerShell 5.1 delivers for '{"model":"a/b"}'.
    expect(await refused(["{model:a/b}"])).toContain("the shell may have removed the double quotes")
    expect(await refused(['{"model":'])).not.toContain("double quotes")
  })

  test("that is not an object is not JSON for --settings, so it is a file name that does not exist", async () => {
    for (const value of ["[1]", '"x"', "1"])
      expect(await refused([value])).toBe(`--settings: ${value} is not a file that exists and is not JSON`)
  })
})

describe("one value, and not an empty one", () => {
  test.each([
    [[""], "the value is empty"],
    [["   "], "the value is empty"],
    [["{}", "{}"], "was given 2 times"],
  ])("%j is refused with one line", async (settings, message) => {
    const text = await refused(settings)
    expect(text).toContain(message)
    expect(text).toContain("--settings")
    expect(text.split("\n")).toHaveLength(1)
  })
})

describe("a file", () => {
  test("travels by its real path and is never merged as content", async () => {
    const elsewhere = path.join(root, "elsewhere")
    await Bun.write(path.join(elsewhere, "s.json"), '{"shell":"{file:./note.txt}"}')
    const built = await build([path.join(elsewhere, "s.json")])
    expect(built).toEqual({ file: await fs.realpath(path.join(elsewhere, "s.json")) })
    expect(built?.content).toBeUndefined()
  })

  test("is checked before it is opened: missing, a folder, and a name the system treats as a device", async () => {
    await fs.mkdir(path.join(typed, "folder.json"), { recursive: true })
    const device = process.platform === "win32" ? ["NUL", "CON", "con.json", "COM1", "LPT1"] : []
    const names = ["missing.json", "folder.json", ...device]
    for (const name of names) {
      const message = await refused([name])
      expect({ name, message: message.startsWith(`--settings: ${name} `) }).toEqual({ name, message: true })
      expect(message.split("\n")).toHaveLength(1)
      // stat reports these names as missing, so only the device guard gives the message that says what they are.
      if (device.includes(name)) expect(message).toContain("is not a regular file; pass the JSON itself instead")
    }
  })

  test("a third value reaches the handler and is refused in one line", async () => {
    const message = await refused(["a.json", "b.json", "c.json"])
    expect(message).toBe("--settings was given 3 times; give one file or one JSON value")
  })

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a file that cannot be read after it was found names the flag",
    async () => {
      const locked = path.join(typed, "locked.json")
      await Bun.write(locked, "{}")
      await fs.chmod(locked, 0o000)
      try {
        const message = await refused(["locked.json"])
        expect(message).toStartWith("--settings: locked.json could not be read: ")
        expect(message.split("\n")).toHaveLength(1)
      } finally {
        await fs.rm(locked, { force: true })
      }
    },
  )

  test.skipIf(process.platform === "win32")(
    "a standard input or process substitution path is refused with a hint",
    async () => {
      for (const name of ["/dev/stdin", "/dev/fd/63", "/proc/self/fd/0"])
        expect(await refused([name])).toContain("pass the JSON itself instead")
    },
  )

  test.skipIf(process.platform === "win32")("a FIFO is refused without being opened", async () => {
    const fifo = path.join(typed, "pipe.json")
    await Bun.spawn(["mkfifo", fifo]).exited
    try {
      expect(await refused([fifo])).toContain("is not a file that exists and is not JSON")
    } finally {
      await fs.rm(fifo, { force: true })
    }
  })

  test("over 4 MiB is refused before it is read", async () => {
    const big = path.join(typed, "big.json")
    await Bun.write(big, " ".repeat(ConfigOverlay.MAX_BYTES + 1))
    expect(await refused([big])).toContain(`is ${ConfigOverlay.MAX_BYTES + 1} bytes; the most one run takes is`)
  })

  test("that does not parse names the file and the offset", async () => {
    await Bun.write(path.join(typed, "bad.json"), '{"model":')
    const message = await refused(["bad.json"])
    expect(message).toContain("--settings bad.json: invalid JSON")
    expect(message).toMatch(/at offset \d+/)
    await Bun.write(path.join(typed, "list.json"), "[1]")
    expect(await refused(["list.json"])).toContain("expected a JSON object")
  })

  test("a name with control characters is printed escaped", async () => {
    const message = await refused(["\u001b[31mred\u0007.json"])
    expect(message).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/)
    expect(message).toContain("is not a file that exists")
  })

  test("an empty or blank file is an empty document that the server has nothing to load for", async () => {
    for (const text of ["", " \n\t "]) {
      await Bun.write(path.join(typed, "blank.json"), text)
      expect(await build(["blank.json"])).toEqual({ file: undefined })
    }
  })

  test("is read the way the server reads it: UTF-8 with or without a byte-order mark, and not UTF-16", async () => {
    const file = path.join(typed, "encoded.json")
    const real = await fs.realpath(typed)
    await Bun.write(file, '{"shell":"x"}')
    expect((await build(["encoded.json"]))?.file).toBe(path.join(real, "encoded.json"))
    await Bun.write(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"shell":"x"}')]))
    expect((await build(["encoded.json"]))?.file).toBe(path.join(real, "encoded.json"))
    // What Windows PowerShell 5.1 writes for '{...}' > s.json, and its other byte order.
    await Bun.write(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"shell":"x"}', "utf16le")]))
    expect(await refused(["encoded.json"])).toContain("is UTF-16; save it as UTF-8")
    await Bun.write(file, Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('{"shell":"x"}', "utf16le").swap16()]))
    expect(await refused(["encoded.json"])).toContain("is UTF-16; save it as UTF-8")
  })
})

describe("apply", () => {
  const applied = (input: Parameters<typeof ConfigOverlay.apply>[0]) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const used = yield* ConfigOverlay.apply(input)
        const file = process.env.ORBIT_CONFIG_CONTENT_FILE
        const text = file ? yield* Effect.promise(() => Bun.file(file).text()) : undefined
        return { used, envelope: text === undefined ? undefined : JSON.parse(text) }
      }).pipe(Effect.scoped),
    )

  test("refuses --server before it reads the value", async () => {
    const message = await Effect.runPromise(
      ConfigOverlay.apply({ settings: ["does-not-exist.json"], server: "http://127.0.0.1:1" }).pipe(
        Effect.map(() => ""),
        Effect.catch((error) => Effect.succeed(error.message)),
        Effect.scoped,
      ),
    )
    expect(message).toBe(
      "--settings cannot be combined with --server: the config belongs to a private server started for this run",
    )
    expect(ConfigOverlay.given({ settings: ["x"], mcpConfig: ["y"], agents: "{}" })).toEqual([
      "--settings",
      "--mcp-config",
      "--agents",
    ])
  })

  test("a file reaches the server in the envelope and ORBIT_CONFIG is left as it was", async () => {
    const file = path.join(typed, "run.json")
    await Bun.write(file, '{"shell":"x"}')
    const before = process.env.ORBIT_CONFIG
    try {
      process.env.ORBIT_CONFIG = "inherited.json"
      const run = await Effect.runPromise(
        Effect.gen(function* () {
          const used = yield* ConfigOverlay.apply({ settings: [file], server: undefined })
          const envelope = JSON.parse(
            yield* Effect.promise(() => Bun.file(process.env.ORBIT_CONFIG_CONTENT_FILE!).text()),
          )
          return { used, envelope, config: process.env.ORBIT_CONFIG }
        }).pipe(Effect.scoped),
      )
      expect(run.used).toBe(true)
      expect(run.envelope).toEqual({ version: 2, file: await fs.realpath(file) })
      expect(run.config).toBe("inherited.json")
      expect(process.env.ORBIT_CONFIG_CONTENT_FILE).toBeUndefined()
    } finally {
      if (before === undefined) delete process.env.ORBIT_CONFIG
      else process.env.ORBIT_CONFIG = before
    }
  })

  test("inline JSON reaches the server as content and no file", async () => {
    const run = await applied({ settings: ['{"shell":"x"}'], server: undefined })
    expect(run.used).toBe(true)
    expect(run.envelope.version).toBe(2)
    expect(JSON.parse(run.envelope.content)).toMatchObject({ shell: "x" })
    expect(run.envelope.file).toBeUndefined()
  })
})

// The server side of the same transport: a version 1 envelope is not one the server takes.
test("the server takes a version 2 envelope and refuses a version 1 one", async () => {
  const written = await ConfigOverlay.write({ content: "{}", file: "/x/s.json" })
  try {
    expect(await ConfigOverlay.consume(written.file)).toEqual({ content: "{}", file: "/x/s.json" })
    await Bun.write(written.file, JSON.stringify({ version: 1, content: "{}" }))
    await expect(ConfigOverlay.consume(written.file)).rejects.toThrow("version 2 overlay")
  } finally {
    await written.remove()
  }
})

describe("the interface", () => {
  test.each([[[]], [["run"]], [["mini"]], [["loop"]], [["debug", "config"]]])(
    "orb %j lists --settings and says it uses a private server",
    async (command) => {
      const help = await orb([...command, "--help"])
      expect(help.stdout).toContain("--settings")
      expect(help.stdout).toContain("private server")
      expect(help.stdout).toContain("cannot be combined with --server")
    },
  )

  test("--settings with --server is refused by every command that takes it, before the value is read", async () => {
    const message =
      "--settings cannot be combined with --server: the config belongs to a private server started for this run"
    for (const args of [
      ["hi", "--settings", "none.json", "--server", "http://127.0.0.1:1"],
      ["-p", "--settings", "none.json", "--server", "http://127.0.0.1:1", "hi"],
      ["run", "--settings", "none.json", "--server", "http://127.0.0.1:1", "hi"],
      ["loop", "--settings", "none.json", "--server", "http://127.0.0.1:1", "10s", "hi"],
    ]) {
      const result = await orb(args)
      expect({ args, code: result.code, said: result.stdout + result.stderr }).toMatchObject({
        args,
        code: 1,
        said: expect.stringContaining(message),
      })
    }
  })
})

// End to end: a private server started for the run, asked what it loaded.
describe("what the private server loads", () => {
  const home = path.join(root, "e2e")
  const project = path.join(home, "work", "project")
  const managed = path.join(home, "managed")
  const base = { ORBIT_CONFIG_CONTENT: undefined, ORBIT_CONFIG: undefined }
  const run = (args: string[], env: Record<string, string | undefined> = {}, cwd = project, timeout = 120_000) =>
    orb(args, env, cwd, timeout, home)

  beforeAll(async () => {
    // The private server starts in the folder the command runs in and compiles the interface's JSX with the preload that
    // the package's own bunfig.toml names, which Bun reads from that folder.
    const preload = Bun.resolveSync("@opentui/solid/preload", path.join(import.meta.dir, "..")).replaceAll("\\", "/")
    await Promise.all(
      [project, path.join(home, "other")].map((folder) =>
        Bun.write(path.join(folder, "bunfig.toml"), `preload = ["${preload}"]\n`),
      ),
    )
    await Bun.write(path.join(project, "orbit.json"), '{"shell":"project-shell","username":"project-user"}')
    await Bun.write(path.join(project, "orbit.local.json"), '{"shell":"local-shell"}')
    await Bun.write(path.join(project, "note.txt"), "DECOY")
    await Bun.write(path.join(home, "other", "s.json"), '{"shell":"{file:./note.txt}"}')
    await Bun.write(path.join(home, "other", "note.txt"), "BESIDE-THE-FILE")
    await Bun.write(path.join(home, "other", "bom.json"), `\ufeff{"shell":"from-bom"}`)
    await Bun.write(path.join(managed, "managed-settings.json"), '{"shell":"managed-shell"}')
  })

  const entries = async (args: string[], env: Record<string, string | undefined> = {}, cwd = project) => {
    const result = await run(["debug", "config", ...args], { ...base, ...env }, cwd)
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" })
    return JSON.parse(result.stdout) as Array<{ scope?: string; path?: string; info: Record<string, unknown> }>
  }
  const scopes = (list: Awaited<ReturnType<typeof entries>>) => list.map((entry) => entry.scope)

  test("inline JSON is a flag document without a path, after local and before managed, and it wins", async () => {
    const list = await entries(["--settings", '{"shell":"flag-shell"}'], { ORBIT_MANAGED_DIR: managed })
    const flag = list.filter((entry) => entry.scope === "flag")
    expect(flag).toHaveLength(1)
    expect(flag[0].path).toBeUndefined()
    expect(flag[0].info.shell).toBe("flag-shell")
    const order = scopes(list)
    expect(order.lastIndexOf("local")).toBeLessThan(order.indexOf("flag"))
    // Managed settings come last and win.
    expect(order.at(-1)).toBe("managed")
    expect(list.at(-1)?.info.shell).toBe("managed-shell")
  })

  test("a file is a flag document with its real path, and its references resolve beside it", async () => {
    const file = path.join(home, "other", "s.json")
    const list = await entries(["--settings", file])
    const flag = list.filter((entry) => entry.scope === "flag")
    expect(flag.map((entry) => entry.path)).toEqual([await fs.realpath(file)])
    expect(flag[0].info.shell).toBe("BESIDE-THE-FILE")
  })

  test("a relative name is taken from the folder the command was typed in, and a byte-order mark is accepted", async () => {
    const list = await entries(["--settings", "bom.json"], {}, path.join(home, "other"))
    expect(list.filter((entry) => entry.scope === "flag").map((entry) => entry.info.shell)).toEqual(["from-bom"])
  })

  test("--settings file ranks below the inherited content, and inline ranks above it", async () => {
    const file = path.join(home, "other", "bom.json")
    const content = '{"shell":"inherited-content"}'
    const withFile = (await entries(["--settings", file], { ORBIT_CONFIG_CONTENT: content })).filter(
      (entry) => entry.scope === "flag",
    )
    expect(withFile.map((entry) => entry.info.shell)).toEqual(["from-bom", "inherited-content"])
    const inline = (await entries(["--settings", '{"shell":"inline"}'], { ORBIT_CONFIG_CONTENT: content })).filter(
      (entry) => entry.scope === "flag",
    )
    expect(inline.map((entry) => entry.info.shell)).toEqual(["inline"])
  })

  test("a --settings file takes the place of ORBIT_CONFIG, and inline JSON leaves it in place below", async () => {
    const inherited = path.join(home, "other", "s.json")
    const chosen = path.join(home, "other", "bom.json")
    const withFile = (await entries(["--settings", chosen], { ORBIT_CONFIG: inherited })).filter(
      (entry) => entry.scope === "flag",
    )
    expect(withFile.map((entry) => entry.info.shell)).toEqual(["from-bom"])
    const withInline = (await entries(["--settings", '{"shell":"inline"}'], { ORBIT_CONFIG: inherited })).filter(
      (entry) => entry.scope === "flag",
    )
    expect(withInline.map((entry) => entry.info.shell)).toEqual(["BESIDE-THE-FILE", "inline"])
  })

  test("project files stay out of a run that switched them off, and the flag document stays", async () => {
    const list = await entries(["--settings", '{"shell":"flag-shell"}'], { ORBIT_DISABLE_PROJECT_CONFIG: "1" })
    expect(scopes(list)).not.toContain("project")
    expect(scopes(list)).not.toContain("local")
    expect(list.filter((entry) => entry.scope === "flag").map((entry) => entry.info.shell)).toEqual(["flag-shell"])
  })

  test("a file the person named is not held back in a folder nothing trusts, and the project's own file stays held back", async () => {
    const team = path.join(project, "team.json")
    await Bun.write(team, '{"shell":"team-shell","username":"team-user"}')
    const untrusted = { ORBIT_TRUST_PROJECT: undefined }
    const named = await entries(["--settings", team], untrusted)
    const flag = named.filter((entry) => entry.scope === "flag")
    expect(flag).toHaveLength(1)
    expect(flag[0]).not.toHaveProperty("trusted")
    expect(flag[0].info.shell).toBe("team-shell")

    // The folder's own orbit.json, named again, loads once, at its scope and still withheld.
    const own = await entries(["--settings", path.join(project, "orbit.json")], untrusted)
    const documents = own.filter((entry) => entry.path === path.join(project, "orbit.json"))
    expect(documents).toHaveLength(1)
    expect(documents[0]).toMatchObject({ scope: "project", trusted: false })
    expect(documents[0].info.shell).toBeUndefined()
    expect(scopes(own)).not.toContain("flag")
    if (process.platform === "win32") {
      const upper = await entries(["--settings", path.join(project, "ORBIT.JSON")], untrusted)
      expect(scopes(upper)).not.toContain("flag")
    }
  })

  // The 8.3 short name of a folder (Windows), or undefined where the volume makes none.
  const shortName = (target: string) => {
    if (process.platform !== "win32") return undefined
    const short = Bun.spawnSync(
      [
        "powershell.exe",
        "-NoProfile",
        "-Command",
        "(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:SHORT_OF).ShortPath",
      ],
      { env: { ...process.env, SHORT_OF: target } },
    )
      .stdout.toString()
      .trim()
    return short === "" || short.toLowerCase() === target.toLowerCase() ? undefined : short
  }

  // Decided at load so a volume without short names reports a skip and not a pass.
  const projectShort = shortName(project)
  test.skipIf(projectShort === undefined)(
    "the folder's own file, named from a folder spelled by its 8.3 short name, still loads once and withheld",
    async () => {
      const short = projectShort!
      const list = await entries(["--settings", "./orbit.json"], { ORBIT_TRUST_PROJECT: undefined }, short)
      expect(list.filter((entry) => entry.scope === "flag" && entry.path !== undefined)).toEqual([])
      expect(JSON.stringify(list.filter((entry) => entry.scope === "flag"))).not.toContain("project-shell")
      expect(list.filter((entry) => entry.scope === "project")).toMatchObject([{ trusted: false }])
    },
  )

  // `orb <folder> --settings s.json` opens the interface in <folder>, but the name is the one typed where the command
  // was typed. The folder it opens holds a file of that name that does not parse, so reading it would be refused. The
  // interface has no terminal here and is stopped at the deadline; a refusal would come before it starts.
  test("a relative name is taken from where the command was typed, not from the folder the interface opens", async () => {
    await Bun.write(path.join(project, "typed-here.json"), '{"shell":"typed-here"}')
    await Bun.write(path.join(home, "other", "typed-here.json"), "{ not json")
    const result = await run([path.join(home, "other"), "--settings", "typed-here.json"], base, project, 20_000)
    expect(result.stdout + result.stderr).not.toContain("--settings")
  }, 90_000)

  test("a refused value starts no server and leaves no overlay", async () => {
    const before = await fs.readdir(path.join(home, "state", "orbit", "overlays")).catch(() => [])
    for (const value of ["missing.json", '{"shell":', "NUL"]) {
      const result = await run(["debug", "config", "--settings", value], base, project, 30_000)
      expect({ value, code: result.code }).toEqual({ value, code: 1 })
      expect(result.stderr).toContain("--settings")
    }
    expect(await fs.readdir(path.join(home, "state", "orbit", "overlays")).catch(() => [])).toEqual(before)
  })

  test("orb -p with --settings still stops in a folder that holds config back, and sends nothing", async () => {
    const result = await run(
      ["-p", "--settings", '{"shell":"x"}', "hello"],
      { ...base, ORBIT_TRUST_PROJECT: undefined },
      project,
    )
    expect(result.code).toBe(1)
    expect(result.stdout + result.stderr).toMatch(/trust/i)
  })

  // The parser accepts any count; the handler names the bound. Run as a process so restoring a parser bound of 2 fails.
  test("a third --settings reaches the handler through the real command, in one line", async () => {
    const result = await orb(
      ["debug", "config", "--settings", "a.json", "--settings", "b.json", "--settings", "c.json"],
      base,
      project,
    )
    expect(result.code).not.toBe(0)
    expect(result.stderr + result.stdout).toContain("--settings was given 3 times; give one file or one JSON value")
  })
})

async function orb(
  args: string[],
  env: Record<string, string | undefined> = {},
  cwd = path.join(import.meta.dir, ".."),
  timeout = 120_000,
  home = root,
) {
  // The preload that compiles the interface's JSX comes from the package's bunfig.toml, which Bun reads from the
  // working folder, and some runs start elsewhere.
  const preload = Bun.resolveSync("@opentui/solid/preload", path.join(import.meta.dir, ".."))
  const child = Bun.spawn(
    [process.execPath, "run", "--preload", preload, path.join(import.meta.dir, "../src/index.ts"), ...args],
    {
      cwd,
      timeout,
      env: isolatedEnv(home, { USERPROFILE: home, PWD: cwd, ...env }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}
