export * as DirectoryWatch from "./directory-watch.js"

import { readdirSync, statSync, watch } from "node:fs"
import path from "path"
import type { Subscription, Update } from "./watcher.js"

// The most entries a watch keeps to tell what changed while the system dropped its events. A folder with more is
// reported as changed as a whole when that happens.
const SNAPSHOT_LIMIT = 100_000

/**
 * A recursive directory watch over Bun's fs.watch, reporting what a Parcel watch reports: create, update and delete of
 * files and folders, without the paths the ignore list names and without the changes of a folder's own entry.
 *
 * Windows keeps a bounded buffer of changes for a watch. Past it (an install, a checkout or a build in the folder) the
 * system drops them all and the watch gets one event with no name, so the watch compares the folder with what it knew and
 * reports the difference. A folder that is removed reports itself, on and on and never as an error, so it is reported once,
 * and the watch closes and ends like the file watches do.
 */
export function make(
  directory: string,
  ignore: readonly string[],
  publish: (update: Update) => void,
  end: (() => void) | undefined,
): Subscription {
  // A path is ignored when the list names it, or something above it: the folder itself is ignored too, so a pattern for
  // what is below it is also asked about a name below the folder.
  const matchers = ignore.map((entry) => {
    if (/[*?{}[\]!()]/.test(entry)) {
      const glob = new Bun.Glob(entry)
      return (relative: string) => glob.match(relative) || glob.match(`${relative}/_`)
    }
    const base = path.resolve(directory, entry)
    return (_relative: string, file: string) => {
      const inside = path.relative(base, file)
      return !inside.startsWith("..") && !path.isAbsolute(inside)
    }
  })
  const ignored = (file: string) => {
    const relative = path.relative(directory, file).split(path.sep).join("/")
    return matchers.some((matches) => matches(relative, file))
  }
  const same = (left: string, right: string) =>
    process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right

  let closed = false
  let snapshot: Map<string, string> | undefined
  const subscription = watch(directory, { recursive: true }, (event, name) => {
    if (closed) return
    if (!name) {
      // The system dropped its changes: compare once the events that are waiting have been read.
      if (scheduled) return
      scheduled = true
      setTimeout(rescan, 0)
      return
    }
    const file = path.resolve(directory, name)
    if (same(file, directory)) {
      publish({ path: directory, type: "delete" })
      stop()
      end?.()
      return
    }
    if (ignored(file)) return
    const known = describe(file)
    if (event === "change") {
      // A folder's own entry changes whenever something in it does, which Parcel does not report.
      if (known === undefined || known === "dir") return
      snapshot?.set(file, known)
      publish({ path: file, type: "update" })
      return
    }
    if (known === undefined || !listed(file)) {
      forget(file)
      publish({ path: file, type: "delete" })
      return
    }
    snapshot?.set(file, known)
    publish({ path: file, type: "create" })
  })
  subscription.on("error", () => {})
  snapshot = scan()

  let scheduled = false
  function rescan() {
    scheduled = false
    if (closed) return
    const next = scan()
    const previous = snapshot
    snapshot = next
    if (!next || !previous) return void publish({ path: directory, type: "update" })
    const gone = [...previous.keys()].filter((file) => !next.has(file))
    const made = [...next.keys()].filter((file) => !previous.has(file))
    const changed = [...next].filter(([file, signature]) => previous.has(file) && previous.get(file) !== signature)
    for (const file of gone) publish({ path: file, type: "delete" })
    for (const file of made) publish({ path: file, type: "create" })
    for (const [file] of changed) publish({ path: file, type: "update" })
  }

  function scan() {
    const found = new Map<string, string>()
    const walk = (folder: string): boolean => {
      for (const item of entries(folder)) {
        const file = path.join(folder, item.name)
        if (ignored(file)) continue
        const signature = describe(file)
        if (signature === undefined) continue
        found.set(file, signature)
        if (found.size > SNAPSHOT_LIMIT) return false
        if (item.isDirectory() && !walk(file)) return false
      }
      return true
    }
    return walk(directory) ? found : undefined
  }

  function forget(file: string) {
    if (!snapshot) return
    snapshot.delete(file)
    for (const known of snapshot.keys()) if (known.startsWith(file + path.sep)) snapshot.delete(known)
  }

  // Closed once: Bun shares one watch among those of a path, and a second close of the same watch closes the one that was
  // made after it.
  function stop() {
    if (closed) return
    closed = true
    subscription.close()
  }

  return {
    unsubscribe: () => {
      stop()
      return Promise.resolve()
    },
    backend: "node",
  }
}

// What a path is now: "dir" for a folder, size and time for anything else, nothing when it is not there.
function describe(file: string) {
  const info = statSync(file, { throwIfNoEntry: false })
  if (!info) return undefined
  return info.isDirectory() ? "dir" : `${info.size}:${info.mtimeMs}`
}

// The entries of a folder, none when it is gone or cannot be read: a folder is removed while it is read.
function entries(folder: string) {
  try {
    return readdirSync(folder, { withFileTypes: true })
  } catch {
    return []
  }
}

// Whether the folder lists the name exactly: the system answers for a name in any case, and a case-only rename keeps one.
function listed(file: string) {
  return entries(path.dirname(file)).some((item) => item.name === path.basename(file))
}
