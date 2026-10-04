// TODO: Keep additional network capabilities inside Schema and Protocol as the client grows; /effect must never import
// Core or Server. Preserve these datatype exports so internal model reorganizations do not require caller migrations.
import type { Effect } from "effect"
import type { Orbit } from "./client.js"

export * from "./generated/index"
export { Orbit } from "./client.js"
export type {
  AgentApi,
  AppApi,
  CommandApi,
  ConfigApi,
  EventApi,
  IntegrationApi,
  ModelApi,
  PluginApi,
  ProviderApi,
  ReferenceApi,
  RpcApi,
  RpcClient,
  WebSearchApi,
  SessionApi,
  SkillApi,
} from "./api.js"
export { Agent } from "@orbit/schema/agent"
export { Command } from "@orbit/schema/command"
export { Config } from "@orbit/schema/config"
export { Credential } from "@orbit/schema/credential"
export { Event } from "@orbit/schema/event"
export { EventLog } from "@orbit/schema/event-log"
export { FileSystem } from "@orbit/schema/filesystem"
export { Form } from "@orbit/schema/form"
export { Integration } from "@orbit/schema/integration"
export { Location } from "@orbit/schema/location"
export { Model } from "@orbit/schema/model"
export { Permission } from "@orbit/schema/permission"
export { PermissionSaved } from "@orbit/schema/permission-saved"
export { Project } from "@orbit/schema/project"
export { Worktree } from "@orbit/schema/worktree"
export { Vcs } from "@orbit/schema/vcs"
export { Provider } from "@orbit/schema/provider"
export { Pty } from "@orbit/schema/pty"
export { Question } from "@orbit/schema/question"
export { Reference } from "@orbit/schema/reference"
export { WebSearch } from "@orbit/schema/websearch"
export { AbsolutePath, RelativePath } from "@orbit/schema/schema"
export { Session } from "@orbit/schema/session"
export { SessionInbox } from "@orbit/schema/session-inbox"
export { SessionMessage } from "@orbit/schema/session-message"
export { Skill } from "@orbit/schema/skill"
export { Prompt } from "@orbit/schema/prompt"
export { PromptInput } from "@orbit/schema/prompt-input"
export type { OrbitEvent } from "@orbit/protocol/groups/event"
export type OrbitClient = Effect.Success<ReturnType<typeof Orbit.make>>
