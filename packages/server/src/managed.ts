export * as ServerManaged from "./managed"

import { ManagedSettings } from "@orbit/core/managed-settings"
import { FSUtil } from "@orbit/util/fs-util"
import { Effect } from "effect"

export type Snapshot = ManagedSettings.Snapshot

/**
 * Reads the managed settings in a folder without starting a server, for the frontend commands that report on them
 * (`orb doctor`) and may not import Core themselves.
 */
export const read = (directory: string) => ManagedSettings.read(directory).pipe(Effect.provide(FSUtil.layer))
