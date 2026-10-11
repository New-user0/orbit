import { Form } from "@orbit/schema/form"
import { Model } from "@orbit/schema/model"
import { Permission } from "@orbit/schema/permission"
import { SessionMessage } from "@orbit/schema/session-message"
import { Result, Schema, SchemaIssue } from "effect"

// The lines a program writes to `orb -p --input-format stream-json` (and `orb run`), one JSON object per line. Version 1
// of the protocol that the init line announces. Every ID is decoded with its exact schema here, where it enters, so the
// driver only sees typed values; keys that are not listed are ignored.

export const PROTOCOL_VERSION = 1

const modelRef = Schema.String.check(
  Schema.makeFilter((value: string) => {
    if (value === "default") return true
    // `Model.Ref.parse` is the one reader of the provider/model#variant form and reports a bad one by throwing.
    try {
      Model.Ref.parse(value)
      return true
    } catch {
      return "a model in the form provider/model#variant, or default"
    }
  }),
)

const inputs = {
  user: Schema.Struct({
    text: Schema.String,
    files: Schema.optional(Schema.Array(Schema.String)),
    delivery: Schema.optional(Schema.Literals(["steer", "queue"])),
    id: Schema.optional(SessionMessage.ID),
  }),
  interrupt: Schema.Struct({}),
  permission_reply: Schema.Struct({
    requestID: Permission.ID,
    decision: Schema.Literals(["once", "always", "reject"]),
    message: Schema.optional(Schema.String),
  }),
  form_reply: Schema.Struct({ formID: Form.ID, answer: Form.Answer }),
  form_cancel: Schema.Struct({ formID: Form.ID, message: Schema.optional(Schema.String) }),
  set_model: Schema.Struct({ model: Schema.optional(modelRef) }),
  end: Schema.Struct({}),
}

type Inputs = { [K in keyof typeof inputs]: { readonly type: K } & Schema.Schema.Type<(typeof inputs)[K]> }
export type Input = Inputs[keyof Inputs]

export type InvalidInput = { readonly message: string; readonly path: ReadonlyArray<string> }

const decodeLine = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))

const decoders = Object.fromEntries(
  Object.entries(inputs).map(([type, schema]) => [type, Schema.decodeUnknownResult(schema)]),
) as { [K in keyof typeof inputs]: (value: unknown) => Result.Result<Schema.Schema.Type<(typeof inputs)[K]>, Schema.SchemaError> }

/**
 * Reads one input line. A line that does not decode costs only itself: the error names the path of the first field at
 * fault and never quotes the line, which is the controller's text and can hold control characters.
 */
export function decodeInput(line: string): Result.Result<Input, InvalidInput> {
  const json = decodeLine(line)
  if (Result.isFailure(json)) return Result.fail({ message: "The line is not valid JSON.", path: [] })
  const value = json.success
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return Result.fail({ message: "The line must be a JSON object.", path: [] })
  const type = "type" in value ? value.type : undefined
  if (typeof type !== "string" || !Object.hasOwn(decoders, type))
    return Result.fail({
      message: `The "type" must be one of: ${Object.keys(inputs).join(", ")}.`,
      path: ["type"],
    })
  const decoded = decoders[type as keyof typeof inputs](value)
  if (Result.isFailure(decoded)) {
    const path = issuePath(decoded.failure.issue)
    return Result.fail({
      message: path.length === 0 ? "The line is not a valid input." : `Missing or invalid "${path.join(".")}".`,
      path,
    })
  }
  // Only the fields of the input are kept: a schema without fields hands back whatever object it was given.
  const fields = Object.entries(decoded.success).filter(([key]) => key in inputs[type as keyof typeof inputs].fields)
  return Result.succeed({ type, ...Object.fromEntries(fields) } as Input)
}

function issuePath(issue: SchemaIssue.Issue): string[] {
  if (issue._tag === "Pointer") return [...issue.path.map(String), ...issuePath(issue.issue)]
  if (issue._tag === "Composite" || issue._tag === "AnyOf") {
    const first = issue.issues[0]
    return first ? issuePath(first) : []
  }
  if (issue._tag === "Filter" || issue._tag === "Encoding") return issuePath(issue.issue)
  return []
}

/** Splits a byte stream into lines: UTF-8 is decoded across chunk boundaries and a leading byte-order mark is dropped. */
export function lineReader() {
  // With `ignoreBOM` off the decoder drops a byte-order mark at the start of the stream, which some Windows tools write.
  const decoder = new TextDecoder("utf-8", { ignoreBOM: false })
  let tail = ""
  return {
    /** The complete lines in this chunk. */
    push(chunk: Uint8Array) {
      const lines = (tail + decoder.decode(chunk, { stream: true })).split("\n")
      tail = lines.pop() ?? ""
      return lines
    },
    /** The text after the last newline, as one final line, once the input ends. */
    end() {
      const rest = tail + decoder.decode()
      tail = ""
      return rest === "" ? [] : [rest]
    },
  }
}
