export * as ConfigToolExecution from "./tool-execution.js"

import { Schema } from "effect"
import { optional, PositiveInt } from "../schema.js"

/** How many tool calls of one step run at once when the config does not say. */
export const DEFAULT_MAX_CONCURRENCY = 10

export class Info extends Schema.Class<Info>("Config.ToolExecution")({
  max_concurrency: PositiveInt.pipe(optional).annotate({
    description: "Most tool calls of one step that run at the same time. Defaults to 10.",
  }),
}) {}
