export * as ConfigWatch from "./watch.js"

import path from "path"
import { FSUtil } from "@orbit/util/fs-util"
import type { Watcher } from "../filesystem/watcher.js"
import type { ConfigDiscovery } from "./discovery.js"

export function plan(sources: ConfigDiscovery.Sources) {
  const levels = [sources, ...(sources.home ? [sources.home] : [])]
  const directories = [
    ...(sources.global ? [sources.global] : []),
    ...levels.flatMap((level) => level.project.filter((root) => root.present).map((root) => root.path)),
  ]
  const files = [
    ...levels.flatMap((level) => [...level.direct, ...level.local, ...level.project.map((root) => root.path)]),
    ...sources.compat.map((root) => root.path),
    ...sources.compatSettings,
    ...(sources.compatMcp ? [sources.compatMcp] : []),
    ...(sources.explicit ? [sources.explicit] : []),
  ]
  // Keep a parent watch for each root so deletion/recreation is observable.
  const parents = Map.groupBy(
    files.filter((file) => !directories.some((directory) => file !== directory && FSUtil.contains(directory, file))),
    (file) => path.dirname(file),
  )
  return new Map(
    [
      ...directories.map((path) => ({
        path,
        type: "directory" as const,
        // Team memory is written by the agent, not read as config, so its writes must not reload anything.
        ignore: ["node_modules", ".git", "**/{node_modules,.git}/**", "team-memory", "**/team-memory/**"],
      })),
      ...Array.from(parents, ([parent, files]) => ({
        path: parent,
        type: "entries" as const,
        names: [...new Set(files.map((file) => path.basename(file)))].toSorted(),
      })),
    ].map((target) => [JSON.stringify(target), target satisfies Watcher.WatchInput]),
  )
}
