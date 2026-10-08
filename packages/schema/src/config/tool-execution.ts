export * as ConfigToolExecution from "./tool-execution.js"

import { Schema } from "effect"
import { optional, PositiveInt } from "../schema.js"

export class Info extends Schema.Class<Info>("Config.ToolExecution")({
  max_concurrency: PositiveInt.pipe(optional).annotate({
    description: "Most tool calls of one step that run at the same time. Defaults to 10.",
  }),
}) {}
