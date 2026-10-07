// How Windows finds a program that Orbit starts by a bare name such as `hg`, `git`, `node` or `cmd`.
//
// Such a name is looked for in the working folder of the new process before PATH, by Bun's spawn, by Node's (under Bun
// too), by the lookup that cross-spawn makes and by `cmd.exe`. The working folder can be a repository that is not trusted
// yet, so a repository that holds an `hg.exe` ran it while Orbit identified the project, before any question about trust.
//
// `NoDefaultCurrentDirectoryInExePath` turns the lookup off, but the lookup of a spawn reads it from the environment of the
// process that spawns, never from the environment that the child is given. So every Orbit process has to `install` it
// before anything starts a program. A child is given it as well, so that a `cmd.exe` that the child is or runs skips the
// working folder too. A program whose path is written out is not looked up and runs as before.

/** Sets the variable in the environment of this process. Call it first in every Orbit process, before a program starts. */
export function install() {
  if (process.platform !== "win32" || process.env.NoDefaultCurrentDirectoryInExePath === "1") return
  process.env.NoDefaultCurrentDirectoryInExePath = "1"
}

/** The environment to hand to a child: `env`, or the one of this process when there is none, plus the variable. */
export function environment(env: Readonly<Record<string, string | undefined>> | undefined) {
  if (process.platform !== "win32") return env
  return { ...(env ?? process.env), NoDefaultCurrentDirectoryInExePath: "1" }
}

export * as ProgramLookup from "./program-lookup.js"
