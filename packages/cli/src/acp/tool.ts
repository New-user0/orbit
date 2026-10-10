import { isAbsolute, resolve } from "node:path"
import type { ToolCall, ToolCallContent, ToolCallLocation, ToolCallUpdate, ToolKind } from "@agentclientprotocol/sdk"
import { ToolNames } from "@orbit/schema/tool-names"
import { readDisplayText } from "@orbit/tui/mini/tool"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Patch } from "@orbit/util/patch"
import { Result } from "effect"

export type ToolInput = Record<string, unknown>

// The input fields each built-in tool declares, by its current name, with the old names a recorded call may carry. A
// recorded call keeps the extra keys its schema drops at decode, so a model can add any key to its own input; only a
// declared one describes what the person is asked to approve. A tool with no row, such as an MCP tool, keeps its
// arguments: the prompt shows them only as the raw input.
const shell = ["command", "description", "workdir", "timeout", "run_in_background", "background"]
const declared: Record<string, readonly string[]> = {
  Read: ["file_path", "offset", "limit", "path", "filePath"],
  Edit: [
    "file_path",
    "old_string",
    "new_string",
    "replace_all",
    "path",
    "filePath",
    "oldString",
    "newString",
    "replaceAll",
  ],
  Write: ["file_path", "content", "path", "filePath"],
  NotebookEdit: ["notebook_path", "mode", "cellId", "index", "source", "cellType", "path"],
  LSP: ["action", "path", "line", "character", "query"],
  Glob: ["pattern", "path", "hidden", "limit"],
  Grep: [
    "pattern",
    "path",
    "include",
    "literal",
    "caseSensitive",
    "limit",
    "offset",
    "outputMode",
    "type",
    "multiline",
    "context",
    "before",
    "after",
  ],
  Bash: shell,
  PowerShell: shell,
  WebFetch: ["url", "format", "timeout", "prompt"],
  WebSearch: ["query", "allowedDomains", "blockedDomains"],
  Agent: ["agent", "description", "prompt", "model", "sessionID", "background"],
  Patch: ["patchText"],
  Skill: ["id"],
}

export function declaredFields(tool: string, input: ToolInput): ToolInput {
  const fields = declared[ToolNames.canonical(tool)]
  if (!fields) return input
  return Object.fromEntries(fields.flatMap((key) => (key in input ? [[key, input[key]]] : [])))
}
export type ToolContent = ReadonlyArray<
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string | null }
>

export function toToolKind(toolName: string): ToolKind {
  switch (toolName.toLocaleLowerCase()) {
    case "bash":
    case "powershell":
    case "shell":
      return "execute"
    case "webfetch":
      return "fetch"
    case "edit":
    case "apply_patch":
    case "patch":
    case "write":
      return "edit"
    case "grep":
    case "glob":
    case "context":
    case "context7_resolve_library_id":
    case "context7_get_library_docs":
      return "search"
    case "read":
      return "read"
    case "task":
    case "subagent":
    case "agent":
      return "think"
    default:
      return "other"
  }
}

/**
 * Where a tool call acts. The places the server named on its permission request (`served`) are the ones the tool acts on,
 * and they win; before any is served the places come from the declared fields of the call's input, because a recorded call
 * keeps the keys a model added.
 */
export function toLocations(
  toolName: string,
  rawInput: ToolInput,
  cwd: string,
  served?: ReadonlyArray<string>,
): ToolCallLocation[] {
  if (served !== undefined)
    return Array.from(new Set(served.map((item) => resourcePath(item, cwd))), (path) => ({ path }))
  const input = declaredFields(toolName, rawInput)
  switch (toolName.toLocaleLowerCase()) {
    case "bash":
    case "powershell":
    case "shell": {
      // The shell tools declare `workdir`; a `cwd` key the model adds to its input does not move the command, and an
      // empty one runs it in the session's folder.
      const workdir = stringValue(input.workdir)
      if (workdir) return locationFrom(cwd, workdir)
      // The pending call has no input yet, so it names no place.
      return Object.keys(input).length === 0 ? [] : [{ path: cwd }]
    }
    case "read":
    case "edit":
    case "write":
      return locationFrom(cwd, filePath(input))
    case "notebookedit":
    case "notebook_edit":
      return locationFrom(cwd, stringValue(input.notebook_path) ?? stringValue(input.path))
    case "patch":
    case "apply_patch":
      return locationFrom(
        cwd,
        ...patchHunks(input).flatMap((hunk) => [hunk.path, hunk.type === "update" ? hunk.movePath : undefined]),
      )
    case "external_directory": {
      // The request's own metadata, which the server resolved: not a path in a tool's input.
      const file = stringValue(input.filepath)
      return file ? [{ path: resourcePath(file, cwd) }] : []
    }
    case "glob":
      // Glob searches the session's folder when the model spells its path `undefined` or `null`.
      return input.path === "undefined" || input.path === "null" ? [] : locationFrom(cwd, input.path)
    case "grep":
    case "context":
    case "context7_resolve_library_id":
    case "context7_get_library_docs":
      return locationFrom(cwd, input.path)
    default:
      return []
  }
}

export function pendingToolCall(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly state: { readonly input: ToolInput; readonly title?: string }
  readonly cwd: string
  /** The places the server named on the call's permission request. */
  readonly places?: ReadonlyArray<string>
}): ToolCall {
  return {
    toolCallId: input.toolCallId,
    title: toolTitle(input.toolName, input.state.input, input.state.title),
    kind: toToolKind(input.toolName),
    status: "pending",
    locations: toLocations(input.toolName, input.state.input, input.cwd, input.places),
    rawInput: rawInput(input.toolName, input.state.input, input.cwd),
  }
}

export function runningToolUpdate(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly state: { readonly input: ToolInput; readonly title?: string }
  readonly content?: ToolContent
  readonly cwd: string
  /** The places the server named on the call's permission request. */
  readonly places?: ReadonlyArray<string>
}): ToolCallUpdate {
  return {
    toolCallId: input.toolCallId,
    status: "in_progress",
    kind: toToolKind(input.toolName),
    title: toolTitle(input.toolName, input.state.input, input.state.title),
    locations: toLocations(input.toolName, input.state.input, input.cwd, input.places),
    rawInput: rawInput(input.toolName, input.state.input, input.cwd),
    ...(input.content?.length ? { content: toolContent(input.content) } : {}),
  }
}

export function completedToolUpdate(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly input: ToolInput
  readonly content: ToolContent
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly cwd: string
  /** The places the server named on the call's permission request. */
  readonly places?: ReadonlyArray<string>
}): ToolCallUpdate {
  const normalized = toolContent(input.content)
  // Read's model content is a JSON page envelope; show the clean text instead.
  const firstText = input.content.find((part) => part.type === "text")
  const read = input.toolName.toLocaleLowerCase() === "read" && firstText ? readDisplayText(firstText.text) : undefined
  const images = normalized.filter((part) => part.type === "content" && part.content.type === "image")
  const primary =
    read === undefined
      ? normalized.filter((part) => !images.includes(part))
      : [{ type: "content" as const, content: { type: "text" as const, text: read } }]
  // Only a tool that declares the fields (Edit) has an old and a new text; a key the model adds to another tool's input
  // draws no diff.
  const declaredInput = declaredFields(input.toolName, input.input)
  const oldText = stringValue(declaredInput.old_string) ?? stringValue(declaredInput.oldString)
  const newText = stringValue(declaredInput.new_string) ?? stringValue(declaredInput.newString)
  // The place the server named, else the declared fields of the input: not a key the model added.
  // A call that has places but none to name draws no diff either: the input's spelling can be a link.
  const path = input.places ? input.places[0] : filePath(declaredFields(input.toolName, input.input))
  const diff: ToolCallContent[] =
    oldText === undefined || newText === undefined || path === undefined
      ? []
      : [
          {
            type: "diff",
            path: input.places ? resourcePath(path, input.cwd) : absolutePath(path, input.cwd),
            oldText,
            newText,
          },
        ]
  return {
    toolCallId: input.toolCallId,
    status: "completed",
    locations: toLocations(input.toolName, input.input, input.cwd, input.places),
    content: [...primary, ...diff, ...images],
    rawOutput: {
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    },
  }
}

export function errorToolUpdate(input: {
  readonly toolCallId: string
  readonly toolName: string
  readonly input: ToolInput
  readonly content?: ToolContent
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly error: string
  readonly cwd: string
  /** The places the server named on the call's permission request. */
  readonly places?: ReadonlyArray<string>
}): ToolCallUpdate {
  return {
    toolCallId: input.toolCallId,
    status: "failed",
    kind: toToolKind(input.toolName),
    title: toolTitle(input.toolName, input.input, undefined),
    locations: toLocations(input.toolName, input.input, input.cwd, input.places),
    rawInput: rawInput(input.toolName, input.input, input.cwd),
    content: [...toolContent(input.content ?? []), { type: "content", content: { type: "text", text: input.error } }],
    rawOutput: {
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      error: input.error,
    },
  }
}

function toolContent(content: ToolContent): ToolCallContent[] {
  return content.flatMap((part): ToolCallContent[] => {
    if (part.type === "text") return [{ type: "content", content: { type: "text", text: part.text } }]
    const match = /^data:([^;,]+)(?:;[^,]*)*;base64,(.*)$/.exec(part.uri)
    if (!match?.[1]?.startsWith("image/") || match[2] === undefined) return []
    return [{ type: "content", content: { type: "image", mimeType: match[1], data: match[2] } }]
  })
}

function toolTitle(toolName: string, input: ToolInput, fallback: string | undefined) {
  if (isShell(toolName)) return stringValue(input.command) ?? fallback ?? toolName
  return fallback || toolName
}

function rawInput(toolName: string, input: ToolInput, cwd: string): ToolInput {
  if (!isShell(toolName)) return input
  // The command runs in its workdir or in the session's folder, never in a `cwd` the model added to its input.
  const declared = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "cwd"))
  return input.workdir || Object.keys(declared).length === 0 ? declared : { ...declared, cwd }
}

function isShell(toolName: string) {
  const tool = toolName.toLocaleLowerCase()
  return tool === "bash" || tool === "powershell" || tool === "shell"
}

function locationFrom(cwd: string, ...values: unknown[]): ToolCallLocation[] {
  return Array.from(
    new Set(values.flatMap((value) => (typeof value === "string" && value ? [absolutePath(value, cwd)] : []))),
    (path) => ({ path }),
  )
}

// Sessions migrated from V1 keep their original `filePath` tool inputs, and sessions recorded before the tool rename keep `path`.
export function filePath(input: ToolInput) {
  return stringValue(input.file_path) ?? stringValue(input.path) ?? stringValue(input.filePath)
}

export function patchHunks(input: ToolInput) {
  const patchText = stringValue(input.patchText)
  if (!patchText) return []
  const parsed = Patch.parse(patchText)
  return Result.isSuccess(parsed) ? parsed.success : []
}

/** A path from a tool's input, at the place the tool resolves it to: a leading `~` is the home folder, as it is there. */
export function absolutePath(path: string, cwd: string) {
  return FSUtil.resolveFrom(cwd, path, Global.Path.home)
}

/**
 * A path the server already resolved, such as a request's resource or a served diff's file: absolute or relative to the
 * session's folder, and never a `~` to expand, because a project can have a folder named `~`.
 */
export function resourcePath(path: string, cwd: string) {
  return isAbsolute(path) ? path : resolve(cwd, path)
}

export function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

export * as ACPTool from "./tool"
