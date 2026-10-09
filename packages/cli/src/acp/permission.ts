import type { PermissionOption, ToolCallContent, ToolCallLocation } from "@agentclientprotocol/sdk"
import type { EventSubscribeOutput, OrbitClient, PermissionReplyInput } from "@orbit/client/promise"
import { ToolNames } from "@orbit/schema/tool-names"
import { Patch } from "@orbit/util/patch"
import { Cause, Effect } from "effect"
import type { ACPConnection } from "./connection"
import { ACPPromise } from "./promise"
import { absolutePath, filePath, patchHunks, pendingToolCall, stringValue, toLocations, type ToolInput } from "./tool"

type PermissionEvent = Extract<EventSubscribeOutput, { type: "permission.asked" }>
type Tool = { readonly name: string; readonly input: ToolInput }

type Input = {
  readonly client: OrbitClient
  readonly connection: ACPConnection.Interface
  readonly event: PermissionEvent
  readonly sessionID: string
  readonly clientSessionID: string
  readonly cwd: string
  readonly tool?: Tool
  readonly toolCallPrefix?: string
  readonly titlePrefix?: string
}

const options: PermissionOption[] = [
  { optionId: "once", kind: "allow_once", name: "Allow once" },
  { optionId: "always", kind: "allow_always", name: "Always allow" },
  { optionId: "reject", kind: "reject_once", name: "Reject" },
]

/**
 * Asks the client, then replies to the server. Once `cancelled` completes, the client's request is cancelled or never
 * sent, and the server gets `reject`. The server reply is uninterruptible, so a server that is alive but stuck can
 * hold a cancel past `CancelDrainTimeout`; a dead server fails fast.
 */
export const reply = Effect.fn("cli.acp.permission.reply")(function* (input: Input, cancelled: Effect.Effect<void>) {
  yield* Effect.uninterruptibleMask((restore) =>
    // The race starts racers in order and stops once one is done, so an earlier cancel never starts the ask.
    restore(cancelled.pipe(Effect.as("reject" as const), Effect.raceFirst(ask(input)))).pipe(
      Effect.tapCauseIf(Cause.hasDies, (cause) => Effect.logWarning("ACP permission ask failed", cause)),
      Effect.catchCause(() => Effect.succeed("reject" as const)),
      Effect.flatMap((decision) => respond(input, decision)),
    ),
  )
})

const ask = Effect.fnUntraced(function* (input: Input) {
  const request = input.event.data
  // The call found by the request's source ID is its caller, not always the tool the request is about: a link out of the
  // project asks `external_directory` under a Read, and Code Mode, MCP and Workflow asks come from an Execute or a
  // Workflow. The caller's name and input are shown only when the caller owns the action, and never over the request's
  // own metadata; otherwise the prompt is built from the request alone.
  const caller = input.tool && ToolNames.owns(request.action, input.tool.name) ? input.tool : undefined
  const toolName = caller?.name ?? request.action
  const toolInput: ToolInput = caller
    ? { ...declaredFields(request.action, caller.input), ...request.metadata }
    : { ...request.metadata, resources: request.resources }
  const previews = yield* permissionPreviews(toolName, toolInput, request.metadata, input.cwd, caller !== undefined)
  const toolCallID = input.event.data.source?.id ?? input.event.data.id
  const result = yield* input.connection.requestPermission({
    sessionId: input.clientSessionID,
    toolCall: {
      ...pendingToolCall({
        toolCallId: input.toolCallPrefix ? `${input.toolCallPrefix}:${toolCallID}` : toolCallID,
        toolName,
        state: {
          input: toolInput,
          title: prefixedTitle(
            input.titlePrefix,
            permissionTitle(toolName, toolInput, previews, request.resources, caller !== undefined),
          ),
        },
        cwd: input.cwd,
      }),
      locations: permissionLocations(toolName, toolInput, request.resources, input.cwd),
      ...(previews.length > 0 ? { content: previews } : {}),
    },
    options,
  })
  const selected = result.outcome.outcome === "selected" ? result.outcome.optionId : undefined
  return selected === "once" || selected === "always" ? selected : "reject"
})

function respond(input: Input, decision: PermissionReplyInput["decision"]) {
  return ACPPromise.promise(() =>
    input.client.permission.reply({ sessionID: input.sessionID, requestID: input.event.data.id, decision }),
  )
}

function prefixedTitle(prefix: string | undefined, title: string | undefined) {
  if (!prefix) return title
  if (!title) return prefix
  return `${prefix}: ${title}`
}

// The fields each action's tool declares. A recorded call keeps the extra keys its schema drops at decode, so a model can
// add any key to its own input; only a declared one describes what the person is asked to approve.
const declared: Record<string, readonly string[]> = {
  edit: [
    "file_path",
    "notebook_path",
    "path",
    "filePath",
    "content",
    "old_string",
    "new_string",
    "oldString",
    "newString",
    "replace_all",
    "replaceAll",
  ],
  patch: ["patchText"],
  read: ["file_path", "path", "filePath"],
  lsp: ["file_path", "path", "filePath"],
  list: ["path", "pattern"],
  glob: ["path", "pattern"],
  grep: ["path", "pattern"],
  shell: ["command", "cmd", "workdir", "cwd", "description"],
  webfetch: ["url", "method", "format"],
  websearch: ["query"],
  subagent: ["agent", "prompt", "description"],
}

function declaredFields(action: string, input: ToolInput): ToolInput {
  const fields = declared[ToolNames.legacy(action).toLowerCase()] ?? declared[action.toLowerCase()] ?? []
  return Object.fromEntries(fields.flatMap((key) => (key in input ? [[key, input[key]]] : [])))
}

// Only the edit family has files to show a diff of; the check is by canonical name and alias.
const editFamily = new Set(["edit", "write", "notebook_edit", "multiedit", "patch", "apply_patch"])
const isEditFamily = (name: string) =>
  [name, ToolNames.canonical(name), ToolNames.legacy(name)].some((item) => editFamily.has(item.toLowerCase()))

const permissionPreviews = Effect.fnUntraced(function* (
  toolName: string,
  input: ToolInput,
  metadata: ToolInput,
  cwd: string,
  owned: boolean,
) {
  const tool = toolName.toLocaleLowerCase()
  // The server's own diffs come first: they are what it will write (an Edit converts line endings to the file's, which
  // a replace on the client's copy of old_string does not), and a request whose caller is not the editor has no other.
  // They come only from the request's metadata, and only for the edit family.
  const served = isEditFamily(toolName) ? servedPreviews(metadata, cwd) : []
  if (served.length > 0) return served
  if (!owned) return []
  if (tool === "patch" || tool === "apply_patch") return yield* patchPreviews(input, cwd)
  const file = filePath(input)
  if (!file) return []
  const path = absolutePath(file, cwd)
  if (tool === "write") {
    const content = stringValue(input.content)
    if (content === undefined) return []
    const oldText = yield* readText(path)
    return [diff(path, oldText, content)]
  }
  if (tool !== "edit") return []
  const oldString = stringValue(input.old_string) ?? stringValue(input.oldString)
  const newString = stringValue(input.new_string) ?? stringValue(input.newString)
  if (oldString === undefined || newString === undefined) return []
  const oldText = yield* readText(path)
  const newText =
    input.replace_all === true || input.replaceAll === true
      ? oldText.replaceAll(oldString, newString)
      : oldText.replace(oldString, newString)
  return [diff(path, oldText, newText)]
})

/** The files of `metadata.files`, drawn from their unified patches: the removed and context lines against the added ones. */
function servedPreviews(input: ToolInput, cwd: string): ToolCallContent[] {
  if (!Array.isArray(input.files)) return []
  return input.files.flatMap((item: unknown) => {
    const file = item as { file?: unknown; patch?: unknown } | null
    const name = stringValue(file?.file)
    const patch = stringValue(file?.patch)
    if (name === undefined || patch === undefined) return []
    const before: string[] = []
    const after: string[] = []
    let hunks = 0
    patch.split("\n").forEach((line) => {
      if (line.startsWith("@@")) {
        if (hunks++ === 0) return
        before.push("...")
        after.push("...")
        return
      }
      if (hunks === 0 || line.startsWith("\\")) return
      const text = line.slice(1)
      if (line.startsWith("-")) before.push(text)
      else if (line.startsWith("+")) after.push(text)
      else if (line.startsWith(" ")) {
        before.push(text)
        after.push(text)
      }
    })
    return [diff(absolutePath(name, cwd), before.join("\n"), after.join("\n"))]
  })
}

// Patch.derive throws when a hunk does not match the current file; the patch then gets no previews.
function patchPreviews(input: ToolInput, cwd: string) {
  return Effect.forEach(
    patchHunks(input),
    (hunk) =>
      Effect.gen(function* () {
        const path = absolutePath(hunk.path, cwd)
        if (hunk.type === "add") {
          const newText = hunk.contents.endsWith("\n") || hunk.contents === "" ? hunk.contents : `${hunk.contents}\n`
          return diff(path, "", newText)
        }
        const oldText = yield* readText(path)
        if (hunk.type === "delete") return diff(path, oldText, "")
        const derived = yield* Effect.try(() => Patch.derive(hunk.path, hunk.chunks, oldText))
        return diff(hunk.movePath ? absolutePath(hunk.movePath, cwd) : path, oldText, derived.content)
      }),
    { concurrency: "unbounded" },
  ).pipe(Effect.orElseSucceed((): ToolCallContent[] => []))
}

function diff(path: string, oldText: string, newText: string): ToolCallContent {
  return { type: "diff", path, oldText, newText }
}

function permissionTitle(
  toolName: string,
  input: ToolInput,
  previews: ReadonlyArray<ToolCallContent>,
  resources: ReadonlyArray<string>,
  owned: boolean,
) {
  if (previews.length > 1 && isEditFamily(toolName)) return `${previews.length} files`
  switch (toolName.toLocaleLowerCase()) {
    case "external_directory": {
      const directory = resources.find(isPath)
      return (
        stringValue(input.description) ??
        stringValue(input.command) ??
        stringValue(input.parentDir) ??
        (directory && `Access external directory ${wildcardDirectory(directory)}`)
      )
    }
    case "webfetch": {
      // The method is part of what is approved: a Code Mode POST must not read like the GET that was allowed.
      const method = stringValue(input.method)?.toUpperCase()
      const url = stringValue(input.url) ?? resources.find(isUrl)
      return method && method !== "GET" && method !== "HEAD" ? `${method} ${url ?? ""}`.trim() : url
    }
    case "websearch":
      return stringValue(input.query)
    case "grep":
    case "glob":
      return stringValue(input.pattern)
    case "read":
    case "edit":
    case "write":
    case "patch":
    case "apply_patch":
      return filePath(input) ?? (previews[0]?.type === "diff" ? previews[0].path : undefined)
    default:
      // A request whose caller is not its tool (an MCP call, a Workflow agent) names the action and what it reaches.
      return owned ? undefined : [toolName, ...resources.filter((resource) => resource !== "*")].join(" ")
  }
}

function permissionLocations(
  toolName: string,
  input: ToolInput,
  resources: ReadonlyArray<string>,
  cwd: string,
): ToolCallLocation[] {
  const locations = toLocations(toolName, input, cwd)
  // Outside the project the request's own folder is the whole point of the prompt, so it is always listed.
  if (toolName.toLocaleLowerCase() === "external_directory")
    return Array.from(
      new Set([
        ...locations.map((item) => item.path),
        ...resources.filter(isPath).map((item) => absolutePath(wildcardDirectory(item), cwd)),
      ]),
      (path) => ({ path }),
    )
  if (locations.length > 0) return locations
  // Only a request about files has files for resources: an MCP tool's, an agent's and a fetch's are not places on disk.
  if (!fileActions.has(ToolNames.legacy(toolName).toLowerCase())) return []
  return resources.filter(isPath).map((path) => ({ path: absolutePath(path, cwd) }))
}

const fileActions = new Set(["edit", "write", "read", "patch", "apply_patch", "notebook_edit", "list", "lsp"])

// A URL, a `METHOD url` pair or the `*` wildcard is not a place on disk; a fetch's resources must not become file locations.
const isUrl = (resource: string) => /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(resource)
const isPath = (resource: string) => resource !== "*" && !isUrl(resource) && !/^[A-Z][A-Z-]* \S/.test(resource)

function wildcardDirectory(resource: string) {
  const wildcard = resource.indexOf("*")
  if (wildcard === -1) return resource
  const prefix = resource.slice(0, wildcard)
  return /^[\\/]+$/.test(prefix) || /^[A-Za-z]:[\\/]$/.test(prefix) ? prefix : prefix.replace(/[\\/]+$/, "")
}

// A missing file previews as empty.
function readText(path: string) {
  return Effect.tryPromise(() => Bun.file(path).text()).pipe(Effect.orElseSucceed(() => ""))
}

export * as ACPPermission from "./permission"
