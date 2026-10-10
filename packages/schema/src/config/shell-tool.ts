export * as ConfigShellTool from "./shell-tool.js"

import { Schema } from "effect"
import { optional, PositiveInt } from "../schema.js"

/** How long a foreground shell command runs before its deadline when the config does not say, in milliseconds. */
export const DEFAULT_TIMEOUT = 120_000

/** The largest timeout a shell call may ask for when the config does not say, in milliseconds. */
export const DEFAULT_MAX_TIMEOUT = 600_000

export class Info extends Schema.Class<Info>("Config.ShellTool")({
  timeout: PositiveInt.pipe(optional).annotate({
    description:
      "How long, in milliseconds, a foreground shell command runs before it moves to the background (a command made only of sleeps is stopped instead). Defaults to 120000.",
  }),
  max_timeout: PositiveInt.pipe(optional).annotate({
    description:
      "The largest timeout a shell call may ask for, in milliseconds. Never less than `timeout`. Defaults to 600000.",
  }),
}) {}
