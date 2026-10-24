// shell-safety-6: the Shell service's side of the output cap, run against real processes. A result shows the head of the
// output file (the first `tool_output.max_bytes` bytes, 30,000 unless set, at most 150,000), cut back to a whole
// character; a file that vanished is reported, never read as no output; a link planted at the file is not followed
// (class 4); and a command that left the foreground is killed once its file passes the background limit. Each test
// names what it does on the base.
import { expect } from "bun:test"
import { constants } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Duration, Effect, Schema } from "effect"
import { Document, Info } from "@orbit/schema/config"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Config } from "@orbit/core/config"
import { Environment } from "@orbit/core/environment/index"
import { Location } from "@orbit/core/location"
import { Shell } from "@orbit/core/shell"
import { ShellResult } from "@orbit/core/shell/result"
import { ShellSelect } from "@orbit/core/shell/select"
import { Global } from "@orbit/util/global"
import { hostEnvironmentLayer } from "./fixture/environment"
import { tempGlobalLayer } from "./fixture/global"
import { tempLocationLayer } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const isWindows = process.platform === "win32"

// The end marker is assembled as the command runs, so the command text itself never contains it.
const overflowCommand = (bytes: number) =>
  isWindows
    ? `[Console]::Out.Write('output-start' + ('x' * ${bytes}) + 'output-' + 'end')`
    : `printf output-start; head -c ${bytes} /dev/zero | tr '\\0' 'x'; printf 'output-''end'`

// 20,000 two-byte characters, 40,000 bytes, written as UTF-8 without a byte order mark.
const wideCommand = isWindows
  ? "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; [Console]::Out.Write(([string][char]0xE9) * 20000)"
  : "i=0; while [ $i -lt 2000 ]; do printf '\\303\\251\\303\\251\\303\\251\\303\\251\\303\\251\\303\\251\\303\\251\\303\\251\\303\\251\\303\\251'; i=$((i+1)); done"

/** Prints `start`, waits for `release` to exist, then prints `end`. */
const releaseCommand = (release: string) =>
  isWindows
    ? `[Console]::Out.Write('start'); while (!(Test-Path -LiteralPath '${release}')) { Start-Sleep -Milliseconds 50 }; [Console]::Out.Write('end')`
    : `printf start; while [ ! -e '${release}' ]; do sleep 0.05; done; printf end`

// About a megabyte a second until it is stopped: fast enough to pass a small limit, slow enough not to fill a disk.
const floodCommand = isWindows
  ? "while ($true) { [Console]::Out.Write('x' * 10000); Start-Sleep -Milliseconds 10 }"
  : "line=$(head -c 10000 /dev/zero | tr '\\0' 'x'); while :; do printf '%s' \"$line\"; sleep 0.01; done"

const smallCommand = isWindows ? "[Console]::Out.Write('small')" : "printf small"

const document = (info: object) => new Document({ type: "document", info: Schema.decodeUnknownSync(Info)(info) })

const withShell = <A, E>(
  body: (shell: Shell.Interface, run: (command: string) => Effect.Effect<Shell.Info, unknown>) => Effect.Effect<A, E>,
  options: { config?: object; node?: typeof Shell.node } = {},
) =>
  Effect.gen(function* () {
    const shell = yield* Shell.Service
    const selected = ShellSelect.resolve({ priority: "compat" })
    return yield* body(shell, (command) => shell.create({ shell: selected, command, timeout: 0 }))
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(options.node ?? Shell.node, [
        Location.node.replace(tempLocationLayer),
        Global.node.replace(tempGlobalLayer),
        Config.node.replace(Config.testLayer(options.config ? [document(options.config)] : [])),
        Environment.node.replace(hostEnvironmentLayer),
      ]),
    ),
  )

const waitForOutput = (shell: Shell.Interface, id: Shell.ID): Effect.Effect<void, Shell.NotFoundError> =>
  shell
    .output(id, { cursor: Number.MAX_SAFE_INTEGER })
    .pipe(
      Effect.flatMap((latest) =>
        latest.size > 0
          ? Effect.void
          : Effect.sleep(Duration.millis(20)).pipe(Effect.andThen(waitForOutput(shell, id))),
      ),
    )

// Fails on the base: it reads the tail (the last 51,200 bytes), so the text starts in the middle and ends with
// `output-end`, and 40,000 bytes fit whole.
it.live(
  "reads the head of the output",
  () =>
    withShell((shell, run) =>
      Effect.gen(function* () {
        const result = yield* shell.result(yield* run(overflowCommand(40_000)))
        const output = result.capture?.output ?? ""
        expect(output).toStartWith("output-start")
        expect(output).not.toContain("output-end")
        expect(output.length).toBeLessThanOrEqual(30_000)
        expect(output.length).toBeGreaterThan(29_000)
        expect(result.capture?.truncated).toBe(true)
      }),
    ),
  { timeout: 30_000 },
)

// Fails on the base: `max_bytes` bounds the tail there, so a 1,000-byte limit shows the last 1,000 bytes.
it.live(
  "reads the configured head limit and caps it at 150,000",
  () =>
    Effect.gen(function* () {
      const small = yield* withShell((shell, run) => run(overflowCommand(40_000)).pipe(Effect.flatMap(shell.result)), {
        config: { tool_output: { max_bytes: 1_000 } },
      })
      expect(small.capture?.output).toStartWith("output-start")
      expect(small.capture?.output.length).toBeLessThanOrEqual(1_000)
      expect(small.capture?.output.length).toBeGreaterThan(990)

      const large = yield* withShell((shell, run) => run(overflowCommand(160_000)).pipe(Effect.flatMap(shell.result)), {
        config: { tool_output: { max_bytes: 200_000 } },
      })
      expect(large.capture?.output).toStartWith("output-start")
      expect(large.capture?.output.length).toBeLessThanOrEqual(150_000)
      expect(large.capture?.output.length).toBeGreaterThan(149_000)
      expect(large.capture?.truncated).toBe(true)
    }),
  { timeout: 60_000 },
)

// Fails on the base: the tail of an odd 1,001 bytes starts inside a two-byte character, which decodes as U+FFFD.
it.live(
  "cuts the head back to a whole character",
  () =>
    withShell(
      (shell, run) =>
        Effect.gen(function* () {
          const result = yield* shell.result(yield* run(wideCommand))
          const output = result.capture?.output ?? ""
          expect(output).not.toContain("�")
          expect(output.length).toBeGreaterThan(400)
          expect(Buffer.byteLength(output)).toBeLessThanOrEqual(1_001)
          expect(result.capture?.truncated).toBe(true)
        }),
      { config: { tool_output: { max_bytes: 1_001 } } },
    ),
  { timeout: 30_000 },
)

// Fails on the base: a read that fails resolves to no bytes, so the result is an empty text that names nothing.
it.live(
  "reports an output file that vanished",
  () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        withShell((shell, run) =>
          Effect.gen(function* () {
            const release = path.join(tmp.path, "release")
            const info = yield* run(releaseCommand(release))
            yield* waitForOutput(shell, info.id)
            yield* Effect.promise(() => fs.unlink(info.file))
            yield* Effect.promise(() => fs.writeFile(release, ""))
            const result = yield* shell.result(info)
            expect(result.capture?.output).toContain(info.file)
          }),
        ),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  { timeout: 30_000 },
)

// Whether this process can make a file link: Windows refuses one unelevated without Developer Mode (`EPERM`).
const canLink = await (async () => {
  await using tmp = await tmpdir()
  await fs.writeFile(path.join(tmp.path, "target"), "")
  return fs.symlink(path.join(tmp.path, "target"), path.join(tmp.path, "link"), "file").then(
    () => true,
    () => false,
  )
})()

// Class 4. Fails on the base, which reads through the link and shows the marker's text. On Linux the open refuses the
// link (`O_NOFOLLOW`); Windows has no such flag, so there the `lstat` before the open refuses it. Runs where a file link
// can be made: Linux, Windows CI (elevated) and Windows with Developer Mode.
if (canLink)
  it.live(
    "does not follow a link planted at the output file",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          withShell((shell, run) =>
            Effect.gen(function* () {
              const release = path.join(tmp.path, "release")
              const marker = path.join(tmp.path, "marker.txt")
              yield* Effect.promise(() => fs.writeFile(marker, "MARKER-CONTENT ".repeat(5_000)))
              const info = yield* run(releaseCommand(release))
              yield* waitForOutput(shell, info.id)
              yield* Effect.promise(() => fs.unlink(info.file))
              yield* Effect.promise(() => fs.symlink(marker, info.file))
              yield* Effect.promise(() => fs.writeFile(release, ""))
              const result = yield* shell.result(info)
              expect(result.capture?.output).not.toContain("MARKER")
              expect(result.capture?.output).toContain(info.file)
              // The trusted control: the marker itself is untouched.
              expect((yield* Effect.promise(() => fs.stat(marker))).size).toBe("MARKER-CONTENT ".length * 5_000)
            }),
          ),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    { timeout: 30_000 },
  )

// Class 4, the write side: the command's output file is opened without following a link, so a link at its path is never
// written through. The file's name cannot be guessed before it is made, so the open's flags are read back from the
// kernel's record of the descriptor that writes it. Fails when the stream is opened without `O_NOFOLLOW`. `/proc` is
// Linux's, so this runs there (CI and the Docker gate).
if (process.platform === "linux")
  it.live(
    "opens the output file without following a link",
    () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (tmp) =>
          withShell((shell, run) =>
            Effect.gen(function* () {
              const release = path.join(tmp.path, "release")
              const info = yield* run(releaseCommand(release))
              yield* waitForOutput(shell, info.id)
              const flags = yield* Effect.promise(async () => {
                for (const fd of await fs.readdir("/proc/self/fd")) {
                  const target = await fs.readlink(`/proc/self/fd/${fd}`).catch(() => "")
                  if (target !== info.file) continue
                  const record = await fs.readFile(`/proc/self/fdinfo/${fd}`, "utf8").catch(() => "")
                  const line = record.split("\n").find((entry) => entry.startsWith("flags:"))
                  if (line) return Number.parseInt(line.slice("flags:".length).trim(), 8)
                }
              })
              yield* Effect.promise(() => fs.writeFile(release, ""))
              yield* shell.wait(info.id)
              expect(flags).toBeDefined()
              expect((flags ?? 0) & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW)
              expect((flags ?? 0) & constants.O_WRONLY).toBe(constants.O_WRONLY)
            }),
          ),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ),
    { timeout: 30_000 },
  )

// Class 12, the person's own `!` command. Fails on the base, whose notification carries the tail.
it.live(
  "gives the person's command the head too",
  () =>
    withShell((shell, run) =>
      Effect.gen(function* () {
        const info = yield* run(overflowCommand(40_000))
        const notification = ShellResult.userNotification(yield* shell.result(info))
        expect(notification.text).toContain("output-start")
        expect(notification.text).not.toContain("output-end")
        // Output that did not fit names the kept file, as a moved command's notice does. Fails when `userNotification`
        // leaves that line out. The command whose output fits is the control: it names no file.
        expect(notification.text).toContain(ShellResult.savedNotice(info.file))
        const small = yield* run(smallCommand)
        const whole = ShellResult.userNotification(yield* shell.result(small))
        expect(whole.text).toContain("small")
        expect(whole.text).not.toContain(small.file)
      }),
    ),
  { timeout: 30_000 },
)

// FU-M3-152: the service the product builds watches a moved command at 5 GB every five seconds, as the reference does,
// and its size notice names that limit.
it.live("watches a moved command at 5 GB every five seconds by default", () =>
  Effect.sync(() => {
    expect(Shell.BACKGROUND_LIMIT).toBe(5 * 1024 ** 3)
    expect(Duration.toMillis(Shell.WATCH_INTERVAL)).toBe(5_000)
    expect(ShellResult.sizeNotice(Shell.BACKGROUND_LIMIT)).toBe("Background command killed: output file exceeded 5 GB.")
    expect(ShellResult.sizeNotice(256 * 1024)).toBe("Background command killed: output file exceeded 256 KB.")
  }),
)

// FU-M3-152. Fails on the base, which has neither the seam nor `background`: nothing watches a command that left the
// foreground. The flood that stays in the foreground is the control: only a moved command is watched.
it.live(
  "kills a moved command once its file passes the limit",
  () =>
    withShell(
      (shell, run) =>
        Effect.gen(function* () {
          const moved = yield* run(floodCommand)
          const foreground = yield* run(floodCommand)
          const quiet = yield* run(smallCommand)
          yield* shell.background(moved.id)
          yield* shell.background(quiet.id)

          const killed = yield* shell.wait(moved.id).pipe(Effect.timeout(Duration.seconds(20)))
          expect(killed.status).toBe("killed")
          expect((yield* shell.result(moved)).capped).toBe(true)
          expect((yield* Effect.promise(() => fs.stat(moved.file))).size).toBeGreaterThan(256 * 1024)

          expect((yield* shell.get(foreground.id)).status).toBe("running")
          yield* shell.kill(foreground.id)

          const finished = yield* shell.wait(quiet.id).pipe(Effect.timeout(Duration.seconds(20)))
          expect(finished.status).toBe("exited")
          expect((yield* shell.result(quiet)).capped).toBeUndefined()
        }),
      { node: Shell.nodeWith({ backgroundLimit: 256 * 1024, watchInterval: Duration.millis(50) }) },
    ),
  { timeout: 60_000 },
)

// The watchdog kills with SIGKILL at once, as the reference does, rather than with SIGTERM and a 3-second grace. The
// command ignores SIGTERM (what it starts inherits that), so only SIGKILL stops it. Fails when the watchdog uses the
// ordinary kill, which waits out the grace: the command then lives on for 3 seconds after its file passes the limit.
// POSIX: Windows has no SIGTERM to ignore.
if (!isWindows)
  it.live(
    "kills a moved command past the limit without a grace period",
    () =>
      withShell(
        (shell, run) =>
          Effect.gen(function* () {
            const limit = 256 * 1024
            const moved = yield* run(`trap '' TERM; ${floodCommand}`)
            yield* shell.background(moved.id)
            const passed = (): Effect.Effect<number, Shell.NotFoundError> =>
              shell
                .output(moved.id, { cursor: Number.MAX_SAFE_INTEGER })
                .pipe(
                  Effect.flatMap((latest) =>
                    latest.size > limit
                      ? Effect.sync(() => Date.now())
                      : Effect.sleep(Duration.millis(10)).pipe(Effect.andThen(passed())),
                  ),
                )
            const start = yield* passed()
            const killed = yield* shell.wait(moved.id).pipe(Effect.timeout(Duration.seconds(20)))
            expect(killed.status).toBe("killed")
            expect((yield* shell.result(moved)).capped).toBe(true)
            expect(Date.now() - start).toBeLessThan(2_000)
          }),
        { node: Shell.nodeWith({ backgroundLimit: 256 * 1024, watchInterval: Duration.millis(50) }) },
      ),
    { timeout: 60_000 },
  )
