import { runProgram } from "./run-program"

// PowerShellParse gives its host five seconds from the moment it spawns it (ORBIT_PWSH_PARSE_TIMEOUT_MS), and a host that
// does not answer in time is reported as a failed run that the caller asks about. The first start of PowerShell on a
// machine, with nothing of it read yet, takes most of that by itself on a loaded GitHub runner, so a row that waits for the
// real parser would count that start against the parser. A row that needs the real parser waits for a started host first,
// here, under a deadline of its own, and then spends the five seconds on parsing only. The wait changes no timeout in the
// product and no assertion; it fails, naming what the host printed, when the host cannot start at all.
const started = new Map<string, Promise<void>>()

export function pwshStarted(program: string) {
  const known = started.get(program)
  if (known) return known
  const start = runProgram([program, "-NoProfile", "-NonInteractive", "-NoLogo", "-Command", "1"], { deadline: 120_000 }).then(
    (result) => {
      if (!result.success)
        throw new Error(`${program} did not start: exit ${result.exitCode}\n${Buffer.from(result.stderr).toString()}`)
    },
  )
  started.set(program, start)
  return start
}
