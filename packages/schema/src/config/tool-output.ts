export * as ConfigToolOutput from "./tool-output.js"

import { Schema } from "effect"
import { optional, PositiveInt } from "../schema.js"

export class Info extends Schema.Class<Info>("Config.ToolOutput")({
  max_lines: PositiveInt.pipe(optional).annotate({
    description:
      "No longer used: a shell command's result is limited by max_bytes alone. Accepted so older settings still load.",
  }),
  max_bytes: PositiveInt.pipe(optional).annotate({
    description:
      "Most bytes from the start of a shell command's output that its result keeps (default 30,000, at most 150,000); output past it is saved to a file. Also the ceiling for saving tool results when max_result_chars is not set.",
  }),
  max_result_chars: PositiveInt.pipe(optional).annotate({
    description:
      "Ceiling, in characters, on the size above which a tool result is saved to a file and the model gets a preview with the file's path. A tool may declare a smaller limit; Read never saves. Defaults to max_bytes, else 50,000.",
  }),
  max_message_chars: PositiveInt.pipe(optional).annotate({
    description:
      "Most characters of tool results that one step sends to the model together. When a step's new results pass it, the largest are saved to files and sent as a preview with the file's path until the rest fit. Results of a tool without a result limit, such as Read, never count. Defaults to 200,000.",
  }),
}) {}
