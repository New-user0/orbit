import path from "path"

/**
 * The 8.3 short name that Windows gave `name` in `directory`, as `dir /x` lists it, or undefined where there is none:
 * off Windows, on a volume that does not make short names, or for a name that is already short. A link's row ends with
 * its target in brackets.
 */
export function shortName(directory: string, name: string) {
  if (process.platform !== "win32") return undefined
  const cmd = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe")
  const listing = Bun.spawnSync([cmd, "/d", "/c", "dir", "/x", "/a", directory]).stdout.toString()
  const row = listing
    .split(/\r?\n/)
    .map((line) => line.replace(/ \[[^\]]*\]$/, ""))
    .find((line) => line.endsWith(` ${name}`))
  const short = row?.slice(0, -name.length).trim().split(/\s+/).at(-1)
  return short !== undefined && /~\d/.test(short) ? short : undefined
}
