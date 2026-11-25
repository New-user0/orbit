// Runs a program the way a test used to with Bun.spawnSync, but asynchronously and under a deadline.
//
// A synchronous spawn holds its test worker until it returns, and bun's per-test timeout is a timer that cannot fire
// meanwhile. On Linux, Bun.spawnSync sometimes never returns after its child has exited: the worker spins at full CPU
// with the child left a zombie, and the run never ends (packages/core/test/test-sync-spawn.test.ts). An awaited
// asynchronous spawn leaves the event loop free, and the deadline kills a child that does not end and fails with the
// command and what it printed so far.
//
// The command is passed to Bun.spawn as given: a bare name is looked up exactly as Bun.spawnSync looked it up, so tests
// of program lookup keep what they check (class 10). The result has the fields of Bun.spawnSync's that tests read.
export async function runProgram(
  cmd: string[],
  options: {
    cwd?: string
    env?: Record<string, string | undefined>
    windowsVerbatimArguments?: boolean
    deadline?: number
  } = {},
) {
  const child = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: options.env,
    windowsVerbatimArguments: options.windowsVerbatimArguments,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = collect(child.stdout)
  const stderr = collect(child.stderr)
  const limit = options.deadline ?? 60_000
  const late = Promise.withResolvers<"late">()
  const timer = setTimeout(() => late.resolve("late"), limit)
  const exitCode = await Promise.race([
    Promise.all([child.exited, stdout.done, stderr.done]).then(([code]) => code),
    late.promise,
  ])
  clearTimeout(timer)
  if (exitCode !== "late")
    return { exitCode, success: exitCode === 0, stdout: Buffer.concat(stdout.chunks), stderr: Buffer.concat(stderr.chunks) }
  child.kill("SIGKILL")
  const processes =
    process.platform === "linux"
      ? await new Response(Bun.spawn(["ps", "-eo", "pid,ppid,stat,etimes,args"], { stdin: "ignore" }).stdout).text()
      : ""
  throw new Error(
    [
      `${cmd.join(" ")} did not end within ${limit / 1000} s`,
      `stdout:\n${Buffer.concat(stdout.chunks).toString()}`,
      `stderr:\n${Buffer.concat(stderr.chunks).toString()}`,
      ...(processes ? [`processes:\n${processes}`] : []),
    ].join("\n"),
  )
}

// What a child prints, as it prints it, so a child that never ends can still show what it printed.
function collect(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  const done = (async () => {
    while (true) {
      const next = await reader.read()
      if (next.done) return
      chunks.push(next.value)
    }
  })()
  return { chunks, done }
}
