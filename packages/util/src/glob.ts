import { glob, globIterate, globSync, type GlobOptions } from "glob"
import { minimatch } from "minimatch"

export namespace Glob {
  export interface Options {
    cwd?: string
    absolute?: boolean
    include?: "file" | "all"
    dot?: boolean
    symlink?: boolean
    /** Stops the walk after this many matches, so a caller that gives up on a large result does not pay for all of it. */
    limit?: number
    nocase?: boolean
    /** Take braces literally, as a shell does for a quoted word; brace expansion can run for seconds on a few words. */
    nobrace?: boolean
    /** Take `+(a|b)` and its kin literally. */
    noext?: boolean
  }

  function toGlobOptions(options: Options): GlobOptions {
    return {
      cwd: options.cwd,
      absolute: options.absolute,
      dot: options.dot,
      follow: options.symlink ?? false,
      // Without following links, a link is not looked through either: a pattern with a literal part after a wildcard
      // (`*/x`) would otherwise stat `link/x`, which connects to a share when the link leads to one.
      ...(options.symlink ? {} : { ignore: { ignored: () => false, childrenIgnored: (item) => item.isSymbolicLink() } }),
      nodir: options.include !== "all",
      nocase: options.nocase,
      nobrace: options.nobrace,
      noext: options.noext,
    }
  }

  export async function scan(pattern: string, options: Options = {}): Promise<string[]> {
    if (options.limit !== undefined) {
      const found: string[] = []
      for await (const item of globIterate(pattern, toGlobOptions(options))) {
        found.push(item as string)
        if (found.length >= options.limit) break
      }
      return found
    }
    return glob(pattern, toGlobOptions(options)) as Promise<string[]>
  }

  export function scanSync(pattern: string, options: Options = {}): string[] {
    return globSync(pattern, toGlobOptions(options)) as string[]
  }

  export function match(pattern: string, filepath: string): boolean {
    return minimatch(filepath, pattern, { dot: true })
  }
}
