import { NodeFileSystem } from "@effect/platform-node"
import { compile, emitEffectImported, emitEffectShape, emitPromise, write } from "@orbit/httpapi-codegen"
import { ClientApi, effectOmitEndpoints, groupNames, promiseOmitEndpoints } from "@orbit/protocol/client"
import { Agent } from "@orbit/schema/agent"
import { Command } from "@orbit/schema/command"
import { Config } from "@orbit/schema/config"
import { Credential } from "@orbit/schema/credential"
import { Event } from "@orbit/schema/event"
import { EventLog } from "@orbit/schema/event-log"
import { FileDiff } from "@orbit/schema/file-diff"
import { FileSystem } from "@orbit/schema/filesystem"
import { Form } from "@orbit/schema/form"
import { InstructionEntry } from "@orbit/schema/instruction-entry"
import { Integration } from "@orbit/schema/integration"
import { Location } from "@orbit/schema/location"
import { Mcp } from "@orbit/schema/mcp"
import { Model } from "@orbit/schema/model"
import { Permission } from "@orbit/schema/permission"
import { PermissionSaved } from "@orbit/schema/permission-saved"
import { Plugin } from "@orbit/schema/plugin"
import { Project } from "@orbit/schema/project"
import { Worktree } from "@orbit/schema/worktree"
import { AgentAttachment, FileAttachment, Prompt, PromptMention } from "@orbit/schema/prompt"
import { PromptInput } from "@orbit/schema/prompt-input"
import { Provider } from "@orbit/schema/provider"
import { Pty } from "@orbit/schema/pty"
import { PtyTicket } from "@orbit/schema/pty-ticket"
import { Question } from "@orbit/schema/question"
import { Reference } from "@orbit/schema/reference"
import { AbsolutePath, PositiveInt, RelativePath } from "@orbit/schema/schema"
import { Session } from "@orbit/schema/session"
import { SessionMessage } from "@orbit/schema/session-message"
import { SessionInbox } from "@orbit/schema/session-inbox"
import { SessionTurn } from "@orbit/schema/session-turn"
import { Shell } from "@orbit/schema/shell"
import { Skill } from "@orbit/schema/skill"
import { Vcs } from "@orbit/schema/vcs"
import { WebSearch } from "@orbit/schema/websearch"
import { Effect, Schema } from "effect"
import { fileURLToPath } from "url"

const promiseContract = compile(ClientApi, { groupNames, omitEndpoints: promiseOmitEndpoints })
const effectContract = compile(ClientApi, { groupNames, omitEndpoints: effectOmitEndpoints })
const effectTypeReferences = [
  ...namespaceTypes("Agent", "@orbit/schema/agent", Agent),
  ...namespaceTypes("Command", "@orbit/schema/command", Command),
  ...namespaceTypes("Config", "@orbit/schema/config", Config),
  ...namespaceTypes("Credential", "@orbit/schema/credential", Credential),
  ...namespaceTypes("Event", "@orbit/schema/event", Event),
  ...namespaceTypes("EventLog", "@orbit/schema/event-log", EventLog),
  ...namespaceTypes("FileDiff", "@orbit/schema/file-diff", FileDiff),
  ...namespaceTypes("FileSystem", "@orbit/schema/filesystem", FileSystem),
  ...namespaceTypes("Form", "@orbit/schema/form", Form),
  ...namespaceTypes("InstructionEntry", "@orbit/schema/instruction-entry", InstructionEntry),
  ...namespaceTypes("Integration", "@orbit/schema/integration", Integration),
  typeReference("Location.PublicRef", "@orbit/schema/location", Location.PublicRef),
  typeReference("Location.PublicInfo", "@orbit/schema/location", Location.PublicInfo),
  ...namespaceTypes("Mcp", "@orbit/schema/mcp", Mcp),
  ...namespaceTypes("Model", "@orbit/schema/model", Model),
  ...namespaceTypes("Permission", "@orbit/schema/permission", Permission),
  ...namespaceTypes("PermissionSaved", "@orbit/schema/permission-saved", PermissionSaved),
  ...namespaceTypes("Plugin", "@orbit/schema/plugin", Plugin),
  ...namespaceTypes("Project", "@orbit/schema/project", Project),
  ...namespaceTypes("Worktree", "@orbit/schema/worktree", Worktree),
  ...namespaceTypes("PromptInput", "@orbit/schema/prompt-input", PromptInput),
  ...namespaceTypes("Provider", "@orbit/schema/provider", Provider),
  ...namespaceTypes("Pty", "@orbit/schema/pty", Pty),
  ...namespaceTypes("PtyTicket", "@orbit/schema/pty-ticket", PtyTicket),
  ...namespaceTypes("Question", "@orbit/schema/question", Question),
  ...namespaceTypes("Reference", "@orbit/schema/reference", Reference),
  ...namespaceTypes("Session", "@orbit/schema/session", Session),
  ...namespaceTypes("SessionMessage", "@orbit/schema/session-message", SessionMessage),
  ...namespaceTypes("SessionInbox", "@orbit/schema/session-inbox", SessionInbox),
  ...namespaceTypes("SessionTurn", "@orbit/schema/session-turn", SessionTurn),
  ...namespaceTypes("Shell", "@orbit/schema/shell", Shell),
  ...namespaceTypes("Skill", "@orbit/schema/skill", Skill),
  ...namespaceTypes("Vcs", "@orbit/schema/vcs", Vcs),
  ...namespaceTypes("WebSearch", "@orbit/schema/websearch", WebSearch),
  typeReference("Prompt", "@orbit/schema/prompt", Prompt),
  typeReference("PromptMention", "@orbit/schema/prompt", PromptMention),
  typeReference("FileAttachment", "@orbit/schema/prompt", FileAttachment),
  typeReference("AgentAttachment", "@orbit/schema/prompt", AgentAttachment),
  typeReference("AbsolutePath", "@orbit/schema/schema", AbsolutePath),
  typeReference("PositiveInt", "@orbit/schema/schema", PositiveInt),
  typeReference("RelativePath", "@orbit/schema/schema", RelativePath),
]

await Effect.runPromise(
  Effect.all(
    [
      write(
        emitPromise(promiseContract, {
          mutableOutputs: true,
        }),
        fileURLToPath(new URL("../src/promise/generated", import.meta.url)),
      ),
      write(
        emitEffectImported(effectContract, {
          module: "../../contract",
          api: "ClientApi",
          shapeModule: "../api/api.js",
        }),
        fileURLToPath(new URL("../src/effect/generated", import.meta.url)),
      ),
      write(
        emitEffectShape(effectContract, {
          typeReferences: effectTypeReferences,
          outputTypes: {
            "event.subscribe": {
              name: "OrbitEvent",
              import: 'import type { OrbitEvent } from "@orbit/protocol/groups/event"',
            },
          },
        }),
        fileURLToPath(new URL("../src/effect/api", import.meta.url)),
      ),
    ],
    { concurrency: 3, discard: true },
  ).pipe(Effect.provide(NodeFileSystem.layer)),
)

function namespaceTypes(namespace: string, module: string, values: object) {
  return Object.entries(values).flatMap(([name, schema]) =>
    Schema.isSchema(schema) ? [typeReference(`${namespace}.${name}`, module, schema)] : [],
  )
}

function typeReference(name: string, module: string, schema: Schema.Top) {
  return {
    schema,
    name,
    import: `import type { ${name.split(".")[0]} } from ${JSON.stringify(module)}`,
  }
}
