import { Option } from "effect"
import { Print } from "../commands"
import { Runtime } from "../../framework/runtime"
import { headlessInput } from "./run"

// `orb -p` is `orb run` with the message taken from the words after the flags: text prints the answer, and json prints
// the one result object that `orb run --format result` prints.
export default Runtime.handler(Print, (input) =>
  headlessInput({ ...input, format: Option.getOrUndefined(input.outputFormat) === "json" ? "result" : "default" }),
)
