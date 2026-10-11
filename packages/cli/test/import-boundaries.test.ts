import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")

describe("CLI frontend import boundaries", () => {
  test("does not import Core directly", async () => {
    const glob = new Bun.Glob("{src,test}/**/*.{ts,tsx}")
    const imports: string[] = []
    for await (const file of glob.scan({ cwd: path.join(root, "packages/cli") })) {
      const source = await Bun.file(path.join(root, "packages/cli", file)).text()
      if (/["']@orbit\/core(?:\/[^"']*)?["']/.test(source)) imports.push(file)
    }
    expect(imports).toEqual([])
  })

  test("exposes only the intentional package entrypoints", async () => {
    const run = await import("@orbit/cli/run")
    const mini = await import("@orbit/tui/mini")
    const tool = await import("@orbit/tui/mini/tool")
    const cli = await Bun.file(path.join(root, "packages/cli/package.json")).json()

    expect(Object.keys(run).sort()).toEqual(["runNonInteractive", "runV1Bridge"])
    expect(Object.keys(mini).sort()).toEqual(["runMiniFrontend"])
    expect(Object.keys(tool).sort()).toEqual([
      "nonEmptyToolContent",
      "readDisplayText",
      "toolInlineInfo",
      "toolOutputText",
    ])
    expect(Object.keys(cli.exports).filter((key) => key === "./mini" || key.startsWith("./mini/"))).toEqual([])
  })

  test("keeps run and Mini on separate evaluation graphs", async () => {
    const run = await bundleInputs("packages/cli/src/commands/handlers/run.ts")
    expect(run).toContain("packages/cli/src/run/run.ts")
    expect(run).toContain("packages/cli/src/util/error.ts")
    expect(run).toContain("packages/tui/src/mini/tool.ts")
    expect(run).not.toContain("packages/cli/src/ui/prompt.ts")
    expect(run).not.toContain("packages/tui/src/mini/runtime.ts")
    expect(run).not.toContain("packages/tui/src/mini/runtime.lifecycle.ts")
    expect(run).not.toContain("packages/tui/src/mini/footer.ts")
    expect(run).not.toContain("packages/tui/src/mini/scrollback.surface.ts")
    expect(run).not.toContain("packages/tui/src/runtime.tsx")

    const print = await bundleInputs("packages/cli/src/commands/handlers/print.ts")
    expect(print).toContain("packages/cli/src/commands/handlers/run.ts")
    expect(print).toContain("packages/cli/src/run/run.ts")
    expect(print).not.toContain("packages/tui/src/runtime.tsx")
    expect(print).not.toContain("packages/tui/src/app.tsx")
    expect(print).not.toContain("packages/tui/src/mini/runtime.ts")

    // Stream input is part of the printed run, and pulls in no more of the terminal UI than the run itself does.
    expect(print).toContain("packages/cli/src/run/stream.ts")
    expect(print).toContain("packages/cli/src/run/protocol.ts")
    const stream = await bundleInputs("packages/cli/src/run/stream.ts")
    const tui = (graph: string[]) => graph.filter((file) => file.startsWith("packages/tui/"))
    expect(tui(stream).length).toBeGreaterThan(0)
    expect(tui(stream).filter((file) => !tui(run).includes(file))).toEqual([])
    expect(stream).not.toContain("packages/tui/src/runtime.tsx")
    expect(stream).not.toContain("packages/tui/src/app.tsx")
    expect(stream).not.toContain("packages/tui/src/mini/runtime.ts")

    const mini = await bundleInputs("packages/cli/src/commands/handlers/mini.ts")
    expect(mini).toContain("packages/cli/src/mini.ts")
    expect(mini).toContain("packages/tui/src/mini/index.ts")
    expect(mini).toContain("packages/tui/src/mini/runtime.ts")
    expect(mini).not.toContain("packages/cli/src/run/run.ts")
    expect(mini).not.toContain("packages/cli/src/run/noninteractive.ts")
    expect(mini).not.toContain("packages/cli/src/run/ui.ts")
    expect(mini).not.toContain("packages/tui/src/runtime.tsx")
  })

  test("keeps compat independent from Core, Server, and Client", async () => {
    // Core, the TUI and the CLI all import compat, so it may depend on Schema and Util only.
    const glob = new Bun.Glob("{src,test}/**/*.{ts,tsx}")
    const imports: string[] = []
    for await (const file of glob.scan({ cwd: path.join(root, "packages/compat") })) {
      const source = await Bun.file(path.join(root, "packages/compat", file)).text()
      if (/["']@orbit\/(?:core|server|client)(?:\/[^"']*)?["']/.test(source)) imports.push(file)
    }
    expect(imports).toEqual([])

    const manifest = await Bun.file(path.join(root, "packages/compat/package.json")).json()
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    expect(declared.filter((name) => /^@orbit\/(?:core|server|client)$/.test(name))).toEqual([])

    for (const entrypoint of ["names", "switch", "roots", "instructions", "aliases", "settings", "mcp-json", "zed"]) {
      const graph = await bundleInputs(`packages/compat/src/${entrypoint}.ts`)
      expect(graph.filter((file) => /^packages\/(?:core|server|client|cli|tui)\//.test(file))).toEqual([])
    }
  })

  test("resolves Zed's SQLite binding to the variant of each build target", async () => {
    // The TUI imports the reader from compat, and Bun and Node builds must each reach their own binding.
    const bun = await bundleInputs("packages/compat/src/zed.ts")
    expect(bun).toContain("packages/compat/src/zed-sqlite.bun.ts")
    expect(bun).not.toContain("packages/compat/src/zed-sqlite.node.ts")

    const node = await bundleInputs("packages/compat/src/zed.ts", "node")
    expect(node).toContain("packages/compat/src/zed-sqlite.node.ts")
    expect(node).not.toContain("packages/compat/src/zed-sqlite.bun.ts")
  })

  test("keeps TUI Mini independent from Core, Server, and CLI", async () => {
    const glob = new Bun.Glob("**/*.{ts,tsx}")
    const imports: string[] = []
    for await (const file of glob.scan({ cwd: path.join(root, "packages/tui/src/mini") })) {
      const source = await Bun.file(path.join(root, "packages/tui/src/mini", file)).text()
      if (/["']@orbit\/(?:core|server|cli)(?:\/[^"']*)?["']/.test(source)) imports.push(file)
    }
    expect(imports).toEqual([])

    const graph = await bundleInputs("packages/tui/src/mini/index.ts")
    expect(graph.filter((file) => file.startsWith("packages/core/"))).toEqual([])
    expect(graph.filter((file) => file.startsWith("packages/cli/") || file.startsWith("packages/server/"))).toEqual([])
  })
})

async function bundleInputs(entrypoint: string, target: "bun" | "node" = "bun") {
  const temporary = await mkdtemp(path.join(import.meta.dir, ".import-boundary-"))
  const metafile = path.join(temporary, "meta.json")
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "build",
        entrypoint,
        `--target=${target}`,
        "--format=esm",
        "--packages=bundle",
        "--external=@opentui/core-*",
        `--metafile=${metafile}`,
        `--outdir=${path.join(temporary, "out")}`,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (exitCode !== 0) throw new Error(stdout + stderr)
    const metadata = await Bun.file(metafile).json()
    return Object.keys(metadata.inputs).map((input) =>
      path.relative(root, path.resolve(root, input)).replaceAll(path.sep, "/"),
    )
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
