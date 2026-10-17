import path from "path"
import { which } from "@orbit/util/which"

// The file that stands for git on Windows when it is on no PATH: one that is not there, in a folder that only an
// administrator writes to, so that starting it fails as starting a git that is not installed fails.
const MISSING = "git-is-not-on-path"

export function resolveGitExecutable(platform: NodeJS.Platform, resolved: string | null) {
  if (platform !== "win32") return "git"
  if (resolved) return path.resolve(resolved)
  // Never the bare name `git`. The library that the spawner uses to start a program looks in the working folder of the new
  // process before PATH on Windows, for a name with no extension too, and starts the interpreter that a `#!` line in a file
  // of that name gives. `NoDefaultCurrentDirectoryInExePath` stops the file system lookup and not that one, so a clone that
  // holds a file called `git` ran it in whatever folder Orbit asked git something (class 10).
  return path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", MISSING)
}

const resolved = process.platform === "win32" ? which("git") : null

export const gitExecutable = resolveGitExecutable(process.platform, resolved)
