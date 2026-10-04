import type { Orbit } from "./client.js"

export * from "./generated/index.js"
export { Orbit } from "./client.js"
export type {
  AgentApi,
  CommandApi,
  ConfigApi,
  EventApi,
  IntegrationApi,
  ModelApi,
  PluginApi,
  ProviderApi,
  ReferenceApi,
  RpcApi,
  RpcCallOptions,
  RpcClient,
  RpcEventPayload,
  WebSearchApi,
  SessionApi,
  SkillApi,
} from "./api.js"
export type { EventSubscribeOutput as OrbitEvent } from "./generated/types.js"
export type OrbitClient = ReturnType<typeof Orbit.make>
