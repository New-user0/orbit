import type { PermissionOption, ToolCallContent, ToolCallLocation } from "@agentclientprotocol/sdk"
import type { EventSubscribeOutput, OrbitClient, PermissionReplyInput } from "@orbit/client/promise"
import { PermissionView } from "@orbit/schema/permission-view"
import { ToolNames } from "@orbit/schema/tool-names"
import { Cause, Effect } from "effect"
import { resolve } from "node:path"
import type { ACPConnection } from "./connection"
import { ACPPromise } from "./promise"
import { declaredFields, pendingToolCall, resourcePath, stringValue, type ToolInput } from "./tool"

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
  // The place, file, method, URL and diff of the approval are the request's own values, which the server resolved and the
  // tool acts on. A model can add any key to its own input and spell a path any way the tool accepts, so the calling
  // tool's input is never read for them; it is passed on only as the call's raw input.
  const view = PermissionView.of(request)
  // The call found by the request's source ID is its caller, not always the tool the request is about: a link out of the
  // project asks `external_directory` under a Read, and Code Mode, MCP and Workflow asks come from an Execute or a
  // Workflow. The caller's name and raw input are shown only when the caller owns the action.
  const caller = input.tool && ToolNames.owns(request.action, input.tool.name) ? input.tool : undefined
  const toolName = caller?.name ?? request.action
  const rawInput: ToolInput = caller
    ? declaredFields(caller.name, caller.input)
    : { ...request.metadata, resources: request.resources }
  const previews = [...servedPreviews(view, input.cwd), ...argumentsContent(view)]
  const toolCallID = input.event.data.source?.id ?? input.event.data.id
  const result = yield* input.connection.requestPermission({
    sessionId: input.clientSessionID,
    toolCall: {
      ...pendingToolCall({
        toolCallId: input.toolCallPrefix ? `${input.toolCallPrefix}:${toolCallID}` : toolCallID,
        toolName,
        state: {
          input: rawInput,
          title: prefixedTitle(
            input.titlePrefix,
            permissionTitle(toolName, view, caller?.input, previews, request, caller !== undefined, input.cwd),
          ),
        },
        cwd: input.cwd,
      }),
      locations: permissionLocations(toolName, view, request, input.cwd),
      ...(previews.length > 0 ? { content: previews } : {}),
    },
    // A request with nothing to save offers no "always": the server would treat it as once.
    options: request.save?.length ? options : options.filter((option) => option.optionId !== "always"),
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

// Only the edit family has files to show a diff of; the check is by canonical name and alias.
const isEditFamily = (name: string) =>
  PermissionView.action(name) === "edit" || ["patch", "notebook_edit"].includes(PermissionView.action(name))

/**
 * The files of the request, drawn from their unified patches: the removed and context lines against the added ones. They
 * are the server's own diffs, what it will write (an Edit converts line endings to the file's, which a replace on the
 * client's copy of old_string does not), and a model-added key in the calling input adds none.
 */
function servedPreviews(view: PermissionView.View, cwd: string): ToolCallContent[] {
  return view.files.map((file) => {
    const before: string[] = []
    const after: string[] = []
    let hunks = 0
    file.patch.split("\n").forEach((line) => {
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
    return diff(resourcePath(file.place ?? file.file, cwd), before.join("\n"), after.join("\n"))
  })
}

/** The arguments of an MCP call as the server sends them, which its caller (Code Mode's Execute) does not show. */
function argumentsContent(view: PermissionView.View): ToolCallContent[] {
  return view.arguments === undefined
    ? []
    : [{ type: "content", content: { type: "text", text: `Arguments: ${view.arguments}` } }]
}

function diff(path: string, oldText: string, newText: string): ToolCallContent {
  return { type: "diff", path, oldText, newText }
}

function permissionTitle(
  toolName: string,
  view: PermissionView.View,
  callerInput: ToolInput | undefined,
  previews: ReadonlyArray<ToolCallContent>,
  request: PermissionEvent["data"],
  owned: boolean,
  cwd: string,
) {
  const metadata: ToolInput = request.metadata ?? {}
  const diffs = previews.filter((item) => item.type === "diff")
  const files = request.resources.filter(isPath)
  if (diffs.length > 1 && isEditFamily(toolName)) return `${diffs.length} files`
  switch (PermissionView.action(request.action)) {
    case "external_directory": {
      const directory = request.resources.find(isPath)
      return (
        stringValue(metadata.description) ??
        stringValue(metadata.command) ??
        stringValue(metadata.parentDir) ??
        (directory && `Access external directory ${wildcardDirectory(directory)}`)
      )
    }
    case "webfetch": {
      // The method is part of what is approved: a Code Mode POST must not read like the GET that was allowed.
      const method = view.method
      return method && method !== "GET" && method !== "HEAD" ? `${method} ${view.url ?? ""}`.trim() : view.url
    }
    case "websearch":
      return stringValue(callerInput?.query)
    case "grep":
    case "glob":
      return view.pattern
    case "read":
    case "edit":
    case "write":
    case "patch":
    case "notebook_edit":
    case "list":
    case "lsp":
      // The file the server named for its rules: relative to the project inside it, absolute outside it. Whatever the
      // calling tool's input spelled changes nothing. A trusted link that leads out keeps its link spelling as the
      // resource, so when that resource is not the place the tool acts on, the real place is the title.
      if (files.length === 1 && (view.places.length === 0 || samePlace(files[0], view.places[0], cwd))) return files[0]
      return view.places[0] ?? files[0] ?? view.files[0]?.file
    default:
      // A request whose caller is not its tool (an MCP call, a Workflow agent) names the action and what it reaches.
      return owned ? undefined : [toolName, ...request.resources.filter((resource) => resource !== "*")].join(" ")
  }
}

function permissionLocations(
  toolName: string,
  view: PermissionView.View,
  request: PermissionEvent["data"],
  cwd: string,
): ToolCallLocation[] {
  const action = PermissionView.action(request.action)
  const paths = request.resources.filter(isPath)
  const metadata: ToolInput = request.metadata ?? {}
  // Outside the project the request's own folder is the whole point of the prompt, so it is always listed.
  if (action === "external_directory")
    return Array.from(
      new Set([
        ...[stringValue(metadata.filepath)].flatMap((item) => (item ? [resourcePath(item, cwd)] : [])),
        ...paths.map((item) => resourcePath(wildcardDirectory(item), cwd)),
      ]),
      (path) => ({ path }),
    )
  // The places the server resolved, which are what its rules were checked against and what the tool acts on.
  if (view.places.length > 0) return view.places.map((path) => ({ path: resourcePath(path, cwd) }))
  if (view.folder) return [{ path: resourcePath(view.folder, cwd) }]
  // A shell command with no folder named runs in the session's folder.
  if (action === "shell") return [{ path: cwd }]
  return []
}

function samePlace(resource: string, place: string, cwd: string) {
  const a = resolve(resourcePath(resource, cwd))
  const b = resolve(resourcePath(place, cwd))
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

// A URL, a `METHOD url` pair or the `*` wildcard is not a place on disk; a fetch's resources must not become file locations.
const isUrl = (resource: string) => /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(resource)
const isPath = (resource: string) => resource !== "*" && !isUrl(resource) && !/^[A-Z][A-Z-]* \S/.test(resource)

function wildcardDirectory(resource: string) {
  const wildcard = resource.indexOf("*")
  if (wildcard === -1) return resource
  const prefix = resource.slice(0, wildcard)
  return /^[\\/]+$/.test(prefix) || /^[A-Za-z]:[\\/]$/.test(prefix) ? prefix : prefix.replace(/[\\/]+$/, "")
}

export * as ACPPermission from "./permission"
