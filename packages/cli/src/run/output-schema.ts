import { DEFAULT_OUTPUT_ATTEMPTS, MAX_OUTPUT_ATTEMPTS } from "@orbit/schema/session-turn"
import type { JsonValue } from "@orbit/client/promise"
import { Option, Schema } from "effect"

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const decodeObject = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.MutableJson))

/** The override of the attempts a structured answer gets, for the prompts one run sends. */
export const ATTEMPTS_VARIABLE = "ORBIT_MAX_STRUCTURED_OUTPUT_RETRIES"

export type OutputSchema = { readonly schema: { readonly [key: string]: JsonValue } } | { readonly error: string }

/**
 * Reads the value of `--json-schema`: JSON text when its first visible character is `{`, otherwise the path of a file.
 * Every way it can fail comes back as a message and nothing throws, so the caller reports it before any session work.
 * The server's check at admission is the authority; this one only gives a fast, readable error for the common mistakes.
 */
export async function readOutputSchema(value: string): Promise<OutputSchema> {
  const inline = value.trimStart().startsWith("{")
  const text = inline ? value : await readFile(value)
  if (typeof text !== "string") return text
  const parsed = decodeJson(text)
  if (Option.isNone(parsed))
    return {
      error: inline
        ? "--json-schema is not valid JSON. Windows PowerShell 5.1 removes the double quotes from inline JSON, so write the schema to a file and pass the path of that file instead."
        : `The schema file ${value} is not valid JSON.`,
    }
  const schema = decodeObject(parsed.value)
  if (Option.isNone(schema) || schema.value.type !== "object")
    return { error: 'The schema must be a JSON object whose root declares "type": "object".' }
  return { schema: schema.value }
}

/** The attempts to ask for, or an error message when the variable is set to something that is not 1 to 20. */
export function readAttempts(
  env: Record<string, string | undefined>,
): { attempts: number | undefined } | { error: string } {
  const value = env[ATTEMPTS_VARIABLE]
  if (value === undefined || value === "") return { attempts: undefined }
  const attempts = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN
  if (Number.isInteger(attempts) && attempts >= 1 && attempts <= MAX_OUTPUT_ATTEMPTS) return { attempts }
  return {
    error: `${ATTEMPTS_VARIABLE} must be a whole number from 1 to ${MAX_OUTPUT_ATTEMPTS} (the default is ${DEFAULT_OUTPUT_ATTEMPTS}).`,
  }
}

async function readFile(path: string): Promise<string | { error: string }> {
  const file = Bun.file(path)
  if (!(await file.exists())) return { error: `The schema file ${path} does not exist.` }
  const bytes = await file.bytes().catch(() => undefined)
  if (!bytes) return { error: `The schema file ${path} could not be read.` }
  // Windows PowerShell 5.1 writes UTF-16 with a byte order mark for `>` and `Out-File`; the decoders drop the mark.
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes)
  return new TextDecoder("utf-8").decode(bytes)
}
