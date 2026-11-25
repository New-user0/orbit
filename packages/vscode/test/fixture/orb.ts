import fs from "node:fs/promises"
import path from "node:path"

// Stand-ins for `orb` that the extension starts as it starts the real one. On Windows the extension runs only a `.exe` or
// a `.com` that it found itself, never a script (class 10), so there the stand-in is a program Bun compiles; elsewhere
// it is a shell script. Either way the tests pass the path without an extension, which the lookup completes on Windows.

const cli = path.join(import.meta.dir, "..", "..", "..", "cli")

/**
 * Puts at `file` an `orb` that runs the CLI from source with its home and its XDG folders under `root`, so it starts its
 * own background service, plus whatever `env` adds. orb reads its working folder from PWD, so the stand-in hands on
 * the folder it was started in, as a real `orb` on PATH would run there.
 */
export async function standIn(file: string, root: string, env: Record<string, string> = {}) {
  const variables = {
    HOME: root,
    // On Windows the home folder comes from here and not from HOME.
    USERPROFILE: root,
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    ORBIT_DISABLE_FILEWATCHER: "true",
    ...env,
  }
  if (process.platform === "win32")
    return compile(
      file,
      `const child = Bun.spawn([${JSON.stringify(process.execPath)}, "run", "src/index.ts", ...process.argv.slice(2)], {
  cwd: ${JSON.stringify(cli)},
  env: { ...process.env, ...${JSON.stringify(variables)}, PWD: process.cwd() },
  stdio: ["inherit", "inherit", "inherit"],
})
process.exit(await child.exited)
`,
    )
  return script(file, [
    `export ${Object.entries(variables)
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
      .join(" ")}`,
    `cd ${JSON.stringify(cli)} && PWD="$OLDPWD" exec ${JSON.stringify(process.execPath)} run src/index.ts "$@"`,
  ])
}

/** Puts at `file` an `orb` that cannot start: it writes `message` to stderr and exits with `code`. */
export async function failing(file: string, message: string, code: number) {
  if (process.platform === "win32")
    return compile(file, `process.stderr.write(${JSON.stringify(message + "\n")})\nprocess.exit(${code})\n`)
  return script(file, [`echo ${JSON.stringify(message)} >&2`, `exit ${code}`])
}

async function compile(file: string, source: string) {
  const result = await Bun.build({
    entrypoints: ["/orb.ts"],
    files: { "/orb.ts": source },
    // The stand-in must not read a bunfig.toml or .env of the folder it is started in.
    compile: { outfile: `${file}.exe`, autoloadBunfig: false, autoloadDotenv: false },
  })
  if (!result.success) throw new AggregateError(result.logs, "Could not build the stand-in orb")
}

async function script(file: string, lines: ReadonlyArray<string>) {
  await Bun.write(file, ["#!/bin/sh", ...lines].join("\n") + "\n")
  await fs.chmod(file, 0o755)
}
