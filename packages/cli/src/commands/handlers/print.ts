import { Effect, Option } from "effect"
import { Print } from "../commands"
import { Runtime } from "../../framework/runtime"
import { headlessInput } from "./run"

// `orb -p` is `orb run` with the message taken from the words after the flags and the output envelope: text prints the
// answer, json prints the one result object, and stream-json prints the init line, the events and the result line.
export default Runtime.handler(Print, (input) => {
  const output = Option.getOrUndefined(input.outputFormat) ?? "text"
  if (input.includePartialMessages && output !== "stream-json")
    return Effect.fail(new Error("--include-partial-messages requires --output-format stream-json"))
  if (input.verbose && output !== "text") return Effect.fail(new Error("--verbose requires --output-format text"))
  return headlessInput({
    ...input,
    format: output === "json" ? "result" : output === "stream-json" ? "stream-json" : "default",
    envelope: true,
    partial: input.includePartialMessages,
    // Showing the model's thinking is part of --verbose.
    thinking: input.thinking || input.verbose,
  })
})
