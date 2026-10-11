import { describe, expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Deferred, Effect, Exit, PlatformError, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { CrossSpawnSpawner } from "@orbit/util/cross-spawn-spawner"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { plant, withCurrentDirectoryOnPath } from "../fixture/decoy"
import { testEffect } from "../lib/effect"

const live = LayerNode.compile(CrossSpawnSpawner.node)
const fx = testEffect(live)

function js(code: string, opts?: ChildProcess.CommandOptions) {
  return ChildProcess.make("node", ["-e", code], opts)
}

function decodeByteStream(stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) {
  return Stream.mkUint8Array(stream).pipe(Effect.map((bytes) => new TextDecoder("utf-8").decode(bytes).trim()))
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function tmpdir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-core-test-"))
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

async function gone(pid: number, timeout = 5_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (!alive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !alive(pid)
}

describe("cross-spawn spawner", () => {
  describe("basic spawning", () => {
    fx.effect(
      "captures stdout",
      Effect.gen(function* () {
        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(ChildProcess.make(process.execPath, ["-e", 'process.stdout.write("ok")'])),
        )
        expect(out).toBe("ok")
      }),
    )

    fx.effect(
      "captures multiple lines",
      Effect.gen(function* () {
        const handle = yield* js('console.log("line1"); console.log("line2"); console.log("line3")')
        const out = yield* decodeByteStream(handle.stdout)
        expect(out).toBe("line1\nline2\nline3")
      }),
    )

    fx.effect(
      "returns exit code",
      Effect.gen(function* () {
        const handle = yield* js("process.exit(0)")
        const code = yield* handle.exitCode
        expect(code).toBe(ChildProcessSpawner.ExitCode(0))
      }),
    )

    fx.effect(
      "returns non-zero exit code",
      Effect.gen(function* () {
        const handle = yield* js("process.exit(42)")
        const code = yield* handle.exitCode
        expect(code).toBe(ChildProcessSpawner.ExitCode(42))
      }),
    )
  })

  describe("cwd option", () => {
    fx.effect(
      "uses cwd when spawning commands",
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(
            ChildProcess.make(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd: tmp.path }),
          ),
        )
        expect(yield* Effect.promise(() => fs.realpath(out))).toBe(yield* Effect.promise(() => fs.realpath(tmp.path)))
      }),
    )

    fx.effect(
      "fails for invalid cwd",
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
            svc.spawn(ChildProcess.make("echo", ["test"], { cwd: "/nonexistent/directory/path" })),
          ),
        )
        expect(Exit.isFailure(exit)).toBe(true)
      }),
    )
  })

  describe("env option", () => {
    fx.effect(
      "passes environment variables with extendEnv",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write(process.env.TEST_VAR ?? "")', {
          env: { TEST_VAR: "test_value" },
          extendEnv: true,
        })
        const out = yield* decodeByteStream(handle.stdout)
        expect(out).toBe("test_value")
      }),
    )

    // Windows keeps one variable per name whatever its case. A plain object keeps two keys, and programs disagree on which
    // one wins, so the merge must leave a single spelling of a name, and the lookup variable must stay at 1.
    if (process.platform === "win32")
      fx.effect(
        "hands the child one spelling of PATH and of the lookup variable",
        Effect.gen(function* () {
          const handle = yield* js(
            "process.stdout.write(JSON.stringify(Object.entries(process.env).filter(([k]) => /^(path|nodefaultcurrentdirectoryinexepath)$/i.test(k))))",
            { env: { PATH: process.env.Path ?? "", nodefaultcurrentdirectoryinexepath: "" }, extendEnv: true },
          )
          const entries = JSON.parse(yield* decodeByteStream(handle.stdout)) as Array<[string, string]>
          expect(entries.filter(([key]) => /^path$/i.test(key))).toHaveLength(1)
          expect(entries.filter(([key]) => /^nodefault/i.test(key))).toEqual([["NoDefaultCurrentDirectoryInExePath", "1"]])
        }),
      )

    fx.effect(
      "passes multiple environment variables",
      Effect.gen(function* () {
        const handle = yield* js(
          "process.stdout.write(`${process.env.VAR1}-${process.env.VAR2}-${process.env.VAR3}`)",
          {
            env: { VAR1: "one", VAR2: "two", VAR3: "three" },
            extendEnv: true,
          },
        )
        const out = yield* decodeByteStream(handle.stdout)
        expect(out).toBe("one-two-three")
      }),
    )
  })

  describe("stderr", () => {
    fx.live(
      "captures both streams across backpressure",
      Effect.gen(function* () {
        const handle = yield* js(
          'process.stdout.write("o".repeat(256 * 1024)); process.stderr.write("e".repeat(256 * 1024))',
        )
        const output = yield* Effect.all([decodeByteStream(handle.stdout), decodeByteStream(handle.stderr)], {
          concurrency: "unbounded",
        })
        expect(output).toEqual(["o".repeat(256 * 1024), "e".repeat(256 * 1024)])
        expect(yield* handle.exitCode).toBe(ChildProcessSpawner.ExitCode(0))
      }),
    )

    fx.effect(
      "captures stderr output",
      Effect.gen(function* () {
        const handle = yield* js('process.stderr.write("error message")')
        const err = yield* decodeByteStream(handle.stderr)
        expect(err).toBe("error message")
      }),
    )

    fx.effect(
      "captures both stdout and stderr",
      Effect.gen(function* () {
        const handle = yield* js(
          [
            "let pending = 2",
            "const done = () => {",
            "  pending -= 1",
            "  if (pending === 0) setTimeout(() => process.exit(0), 0)",
            "}",
            'process.stdout.write("stdout\\n", done)',
            'process.stderr.write("stderr\\n", done)',
          ].join("\n"),
        )
        const [stdout, stderr] = yield* Effect.all([decodeByteStream(handle.stdout), decodeByteStream(handle.stderr)], {
          concurrency: 2,
        })
        expect(stdout).toBe("stdout")
        expect(stderr).toBe("stderr")
      }),
    )
  })

  describe("combined output (all)", () => {
    fx.effect(
      "captures stdout via .all when no stderr",
      Effect.gen(function* () {
        const handle = yield* ChildProcess.make("echo", ["hello from stdout"])
        const all = yield* decodeByteStream(handle.all)
        expect(all).toBe("hello from stdout")
      }),
    )

    fx.effect(
      "captures stderr via .all when no stdout",
      Effect.gen(function* () {
        const handle = yield* js('process.stderr.write("hello from stderr")')
        const all = yield* decodeByteStream(handle.all)
        expect(all).toBe("hello from stderr")
      }),
    )
  })

  describe("delayed output consumption", () => {
    for (const combined of [false, true]) {
      fx.live(
        `retains ${combined ? "combined" : "separate"} output after process completion`,
        Effect.gen(function* () {
          const handle = yield* js(
            'require("node:fs").writeSync(1, "stdout\\n"); require("node:fs").writeSync(2, "stderr\\n")',
          )
          expect(yield* handle.exitCode).toBe(ChildProcessSpawner.ExitCode(0))
          if (combined) {
            const output = yield* decodeByteStream(handle.all)
            expect(output).toContain("stdout")
            expect(output).toContain("stderr")
            return
          }
          const output = yield* Effect.all([decodeByteStream(handle.stdout), decodeByteStream(handle.stderr)], {
            concurrency: "unbounded",
          })
          expect(output).toEqual(["stdout", "stderr"])
        }),
      )
    }
  })

  describe("stdin", () => {
    fx.effect(
      "allows providing standard input to a command",
      Effect.gen(function* () {
        const input = "a b c"
        const stdin = Stream.make(Buffer.from(input, "utf-8"))
        const handle = yield* js(
          'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
          { stdin },
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("a b c")
      }),
    )
  })

  describe("process control", () => {
    for (const mode of ["exit", "SIGKILL"] as const) {
      const test = mode === "SIGKILL" && process.platform === "win32" ? fx.live.skip : fx.live
      test(
        `finishes capture after ${mode} while a grandchild holds stdio`,
        Effect.gen(function* () {
          const tmp = yield* Effect.acquireRelease(
            Effect.promise(() => tmpdir()),
            (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
          )
          const pidFile = path.join(tmp.path, "child.pid")
          yield* Effect.addFinalizer(() =>
            Effect.tryPromise(async () => process.kill(Number(await fs.readFile(pidFile, "utf8")), "SIGKILL")).pipe(
              Effect.ignore,
            ),
          )
          const ready = yield* Deferred.make<void>()
          // The grandchild keeps both pipes open independently of the foreground process.
          const handle = yield* ChildProcess.make(
            "node",
            [path.join(import.meta.dir, "../fixture/held-stdio.cjs"), mode, pidFile],
            { stdin: "ignore", forceKillAfter: 100 },
          )
          const [exit, stdout, stderr] = yield* Effect.all(
            [
              Effect.exit(handle.exitCode),
              decodeByteStream(handle.stdout),
              decodeByteStream(handle.stderr.pipe(Stream.tap(() => Deferred.succeed(ready, undefined)))),
              mode === "SIGKILL"
                ? Deferred.await(ready).pipe(Effect.andThen(handle.kill({ killSignal: "SIGKILL" })))
                : Effect.void,
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.timeout("3 seconds"))

          // Completion must retain foreground output without waiting for the inherited pipes to close.
          expect(stdout).toBe("foreground-out")
          expect(stderr).toBe("foreground-err")
          expect(Exit.isSuccess(exit)).toBe(mode === "exit")
          if (Exit.isSuccess(exit)) expect(exit.value).toBe(ChildProcessSpawner.ExitCode(0))
          expect(yield* handle.isRunning).toBe(false)
          expect(alive(Number(yield* Effect.promise(() => fs.readFile(pidFile, "utf8"))))).toBe(true)
        }),
        10_000,
      )
    }

    fx.effect(
      "kills a running process",
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const handle = yield* js("setTimeout(() => {}, 10_000)")
            yield* handle.kill()
            return yield* handle.exitCode
          }),
        )
        expect(Exit.isFailure(exit) ? true : exit.value !== ChildProcessSpawner.ExitCode(0)).toBe(true)
      }),
    )

    fx.effect(
      "uses the configured kill signal when scope exits",
      Effect.gen(function* () {
        const pid = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* js("setInterval(() => {}, 10_000)", { killSignal: "SIGKILL" })
            return Number(handle.pid)
          }),
        )
        const done = yield* Effect.promise(() => gone(pid))
        expect(done).toBe(true)
      }),
    )

    fx.live(
      "forceKillAfter escalates for stubborn processes",
      Effect.gen(function* () {
        if (process.platform === "win32") return

        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const handle = yield* js('process.on("SIGTERM", () => {}); setInterval(() => {}, 10_000)')
            yield* handle.kill({ forceKillAfter: 100 })
            return yield* handle.exitCode
          }),
        )

        expect(Exit.isFailure(exit) ? true : exit.value !== ChildProcessSpawner.ExitCode(0)).toBe(true)
      }),
    )

    fx.effect(
      "isRunning reflects process state",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("done")')
        yield* handle.exitCode
        const running = yield* handle.isRunning
        expect(running).toBe(false)
      }),
    )
  })

  describe("error handling", () => {
    fx.effect(
      "fails for invalid command",
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            const handle = yield* ChildProcess.make("nonexistent-command-12345")
            return yield* handle.exitCode
          }),
        )
        expect(Exit.isFailure(exit) ? true : exit.value !== ChildProcessSpawner.ExitCode(0)).toBe(true)
      }),
    )
  })

  describe("pipeline", () => {
    fx.effect(
      "pipes stdout of one command to stdin of another",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("hello world")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out.toUpperCase()))',
            ),
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("HELLO WORLD")
      }),
    )

    fx.effect(
      "three-stage pipeline",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("hello world")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out.toUpperCase()))',
            ),
          ),
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out.replaceAll(" ", "-")))',
            ),
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("HELLO-WORLD")
      }),
    )

    fx.effect(
      "pipes stderr with { from: 'stderr' }",
      Effect.gen(function* () {
        const handle = yield* js('process.stderr.write("error")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
            ),
            { from: "stderr" },
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toBe("error")
      }),
    )

    fx.effect(
      "pipes combined output with { from: 'all' }",
      Effect.gen(function* () {
        const handle = yield* js('process.stdout.write("stdout\\n"); process.stderr.write("stderr\\n")').pipe(
          ChildProcess.pipeTo(
            js(
              'process.stdin.setEncoding("utf8"); let out = ""; process.stdin.on("data", (chunk) => out += chunk); process.stdin.on("end", () => process.stdout.write(out))',
            ),
            { from: "all" },
          ),
        )
        const out = yield* decodeByteStream(handle.stdout)
        yield* handle.exitCode
        expect(out).toContain("stdout")
        expect(out).toContain("stderr")
      }),
    )
  })

  describe("Windows-specific", () => {
    fx.effect(
      "uses shell routing on Windows",
      Effect.gen(function* () {
        if (process.platform !== "win32") return

        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(
            ChildProcess.make("set", ["ORBIT_TEST_SHELL"], {
              shell: true,
              extendEnv: true,
              env: { ORBIT_TEST_SHELL: "ok" },
            }),
          ),
        )
        expect(out).toContain("ORBIT_TEST_SHELL=ok")
      }),
    )

    fx.effect(
      "runs cmd scripts with spaces on Windows without shell",
      Effect.gen(function* () {
        if (process.platform !== "win32") return

        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const dir = path.join(tmp.path, "with space")
        const file = path.join(dir, "echo cmd.cmd")

        yield* Effect.promise(() => fs.mkdir(dir, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(file, "@echo off\r\nif %~1==--stdio exit /b 0\r\nexit /b 7\r\n"))

        const code = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.exitCode(
            ChildProcess.make(file, ["--stdio"], {
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
            }),
          ),
        )
        expect(code).toBe(ChildProcessSpawner.ExitCode(0))
      }),
    )

    // cross-spawn runs a .bat file through cmd.exe, which looks in the working folder before PATH, and a program that is
    // itself cmd.exe, as the pager of `orb session list` is, looks up what it runs the same way. The variable that stops
    // cmd.exe from doing it is removed from the test process first, because the shell that runs the tests may set it.
    for (const [name, command, args] of [
      ["a command it was given only a name for", "planted", []],
      ["a program that cmd.exe finds by name", "cmd", ["/c", "planted"]],
    ] as const) {
      fx.effect(
        `does not run ${name} from its own working folder`,
        Effect.gen(function* () {
          if (process.platform !== "win32") return

          const tmp = yield* Effect.acquireRelease(
            Effect.promise(() => tmpdir()),
            (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
          )
          const marker = path.join(tmp.path, "ran.txt")
          yield* Effect.promise(() =>
            fs.writeFile(path.join(tmp.path, "planted.bat"), `@echo off\r\necho ran> "${marker}"\r\n`),
          )

          yield* withCurrentDirectoryOnPath(
            ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
              svc.exitCode(ChildProcess.make(command, args, { cwd: tmp.path, extendEnv: true })),
            ),
          )

          expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        }),
      )
    }

    // A .exe is not found the way a .bat is. Bun's spawn, and Node's under Bun, look in the working folder of the child
    // before PATH for a program they only have a name for, and what stops them is NoDefaultCurrentDirectoryInExePath in the
    // environment of the process that starts the program: the environment of the child is not consulted. So these decoys
    // are real .exe files, and they stand for what Orbit starts by name: `hg` when it identifies a folder that has a
    // `.hg`, `node` for an MCP server, and `cmd` for the pager of `orb session list`.
    for (const [name, args] of [
      ["hg", ["log", "-r", "roots(all())", "-T", "{node}\n"]],
      ["node", ["-e", ""]],
      ["cmd", ["/c", "more"]],
    ] as const) {
      fx.effect(
        `does not run a ${name}.exe that its working folder holds`,
        Effect.gen(function* () {
          if (process.platform !== "win32") return

          const tmp = yield* Effect.acquireRelease(
            Effect.promise(() => tmpdir()),
            (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
          )
          const ran = yield* Effect.promise(() => plant(tmp.path, name))

          yield* withCurrentDirectoryOnPath(
            ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
              // Mercurial is not installed everywhere, so whether the spawn works does not matter, only what it ran.
              Effect.exit(
                svc.exitCode(ChildProcess.make(name, args, { cwd: tmp.path, extendEnv: true, stdin: "ignore" })),
              ),
            ),
          )

          expect(yield* Effect.promise(ran)).toEqual([])
        }),
        // The test compiles its decoy program, which takes longer on a slow disk.
        30_000,
      )
    }

    fx.effect(
      "starts a planted program when it is given the path of the program",
      Effect.gen(function* () {
        if (process.platform !== "win32") return

        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const ran = yield* Effect.promise(() => plant(tmp.path, "hg"))

        yield* withCurrentDirectoryOnPath(
          ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
            svc.exitCode(ChildProcess.make(path.join(tmp.path, "hg.exe"), ["log"], { cwd: tmp.path, extendEnv: true })),
          ),
        )

        // Without this, the tests above would pass with a decoy that cannot run.
        expect(yield* Effect.promise(ran)).toEqual(["hg.exe log"])
      }),
      30_000,
    )

    // A .cmd file that is started by its path runs in a cmd.exe, which looks up what the file runs by name in the working
    // folder before PATH, so a program started by its path needs the variable in its environment as well.
    fx.effect(
      "does not run what a .cmd file that it started by its path looks up by name in its working folder",
      Effect.gen(function* () {
        if (process.platform !== "win32") return

        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const bin = path.join(tmp.path, "bin")
        const work = path.join(tmp.path, "work")
        const marker = path.join(tmp.path, "ran.txt")
        yield* Effect.promise(async () => {
          await fs.mkdir(bin)
          await fs.mkdir(work)
          await fs.writeFile(path.join(bin, "tool.cmd"), "@echo off\r\nplanted\r\n")
          await fs.writeFile(path.join(work, "planted.bat"), `@echo off\r\necho ran> "${marker}"\r\n`)
        })

        yield* withCurrentDirectoryOnPath(
          ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
            svc.exitCode(ChildProcess.make(path.join(bin, "tool.cmd"), [], { cwd: work, extendEnv: true })),
          ),
        )

        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      }),
    )

    // Whatever environment a program is handed, the variable is in it, so a program that is started with a few variables
    // only, by its path or as a command line that is run with a shell, does not look in the working folder either.
    const root = process.env.SystemRoot ?? "C:\\Windows"
    const show = "echo %NoDefaultCurrentDirectoryInExePath%"
    for (const [name, command, args, shell] of [
      ["a path to a program", path.join(root, "System32", "cmd.exe"), ["/c", show], false],
      ["a command line that is run with a shell", show, [], true],
    ] as const) {
      fx.effect(
        `gives ${name} an environment in which cmd.exe skips the working folder`,
        Effect.gen(function* () {
          if (process.platform !== "win32") return

          const out = yield* withCurrentDirectoryOnPath(
            ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
              svc.string(ChildProcess.make(command, args, { shell, env: { SystemRoot: root }, extendEnv: false })),
            ),
          )

          expect(out.trim()).toBe("1")
        }),
      )
    }

    fx.effect(
      "still starts a .cmd file that PATH holds, by name",
      Effect.gen(function* () {
        if (process.platform !== "win32") return

        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const bin = path.join(tmp.path, "bin")
        yield* Effect.promise(async () => {
          await fs.mkdir(bin)
          await fs.writeFile(path.join(bin, "installed.cmd"), "@echo off\r\necho from-path\r\n")
        })
        const root = process.env.SystemRoot ?? "C:\\Windows"

        // cmd.exe runs the file, and has to find it on PATH once it no longer looks in the working folder.
        const out = yield* ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          svc.string(
            ChildProcess.make("installed", [], {
              cwd: tmp.path,
              env: { PATH: `${bin};${path.join(root, "System32")}`, SystemRoot: root },
              extendEnv: false,
            }),
          ),
        )

        expect(out.trim()).toBe("from-path")
      }),
    )

    fx.effect(
      "stops a process without running a taskkill from the folder the process started in",
      Effect.gen(function* () {
        if (process.platform !== "win32") return

        const tmp = yield* Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        )
        const marker = path.join(tmp.path, "ran.txt")
        yield* Effect.promise(() =>
          fs.writeFile(path.join(tmp.path, "taskkill.bat"), `@echo off\r\necho ran> "${marker}"\r\n`),
        )
        const handle = yield* js("setTimeout(() => {}, 3_000)")

        // The spawner stops a process on Windows with taskkill, which cmd.exe looks for in the working folder first.
        yield* withCurrentDirectoryOnPath(
          Effect.acquireUseRelease(
            Effect.sync(() => {
              const before = process.cwd()
              process.chdir(tmp.path)
              return before
            }),
            () => handle.kill(),
            (before) => Effect.sync(() => process.chdir(before)),
          ),
        )

        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        expect(yield* handle.isRunning).toBe(false)
      }),
    )
  })
})
