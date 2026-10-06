export * as Provider from "./provider.js"

import { Context, Effect, Layer, Option, Schema, Stream, Struct } from "effect"
import { Provider } from "@orbit/schema/provider"
import { Model } from "@orbit/schema/model"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { HttpTimeout, type ProviderPackageDefinition } from "@orbit/ai"
import { isRecord } from "@orbit/ai/utils/record"
import { Npm } from "@orbit/util/npm"
import type { DeepMutable } from "./schema.js"
import { importModule, resolveModule } from "@orbit/util/runtime-import"
import { Bus } from "./bus.js"
import { Integration } from "./integration.js"
import { State } from "./state.js"
import { IntegrationConnection } from "./integration/connection.js"
import { Credential } from "@orbit/schema/credential"
import { Location } from "./location.js"
import { freeze } from "immer"
import { AISDKNative } from "./aisdk-native.js"

export const ID = Provider.ID
export type ID = typeof ID.Type

export const AISDK_PREFIX = "aisdk:"
export const isAISDK = (value: string | undefined): value is string => value?.startsWith(AISDK_PREFIX) ?? false
export const aisdk = (value: string) => (isAISDK(value) ? value : `${AISDK_PREFIX}${value}`)
export function packageName(value: string): string
export function packageName(value: undefined): undefined
export function packageName(value: string | undefined): string | undefined
export function packageName(value: string | undefined) {
  // Native provider entrypoints can persist in user configuration across the npm scope migration.
  if (value?.startsWith("@orbit-ai/ai/")) return value.replace("@orbit-ai/", "@orbit/")
  if (value === undefined || !isAISDK(value)) return value
  return value.slice(AISDK_PREFIX.length)
}

type Json = Schema.Schema.Type<typeof Schema.Json>
const JsonRecord = Schema.Record(Schema.String, Schema.Json)
const decodeJsonRecord = Schema.decodeUnknownSync(JsonRecord)

export class LoadError extends Schema.TaggedError<LoadError>()("Provider.LoadError", {
  package: Schema.String,
  cause: Schema.Defect(),
}) {}
export type ProviderPackage = ProviderPackageDefinition

const packages = new Map<string, Promise<unknown>>()
const builtins = new Map<string, () => Promise<unknown>>([
  ["@orbit/ai/providers/amazon-bedrock", () => import("@orbit/ai/providers/amazon-bedrock")],
  ["@orbit/ai/providers/amazon-bedrock/mantle", () => import("@orbit/ai/providers/amazon-bedrock/mantle")],
  ["@orbit/ai/providers/amazon-bedrock/mantle/chat", () => import("@orbit/ai/providers/amazon-bedrock/mantle/chat")],
  [
    "@orbit/ai/providers/amazon-bedrock/mantle/responses",
    () => import("@orbit/ai/providers/amazon-bedrock/mantle/responses"),
  ],
  ["@orbit/ai/providers/alibaba/chat", () => import("@orbit/ai/providers/alibaba/chat")],
  ["@orbit/ai/providers/alibaba/messages", () => import("@orbit/ai/providers/alibaba/messages")],
  ["@orbit/ai/providers/alibaba/responses", () => import("@orbit/ai/providers/alibaba/responses")],
  ["@orbit/ai/providers/anthropic", () => import("@orbit/ai/providers/anthropic")],
  ["@orbit/ai/providers/azure", () => import("@orbit/ai/providers/azure")],
  ["@orbit/ai/providers/azure/chat", () => import("@orbit/ai/providers/azure/chat")],
  ["@orbit/ai/providers/azure/responses", () => import("@orbit/ai/providers/azure/responses")],
  ["@orbit/ai/providers/baseten", () => import("@orbit/ai/providers/baseten")],
  ["@orbit/ai/providers/cerebras", () => import("@orbit/ai/providers/cerebras")],
  ["@orbit/ai/providers/cloudflare-ai-gateway", () => import("@orbit/ai/providers/cloudflare-ai-gateway")],
  ["@orbit/ai/providers/cloudflare-workers-ai", () => import("@orbit/ai/providers/cloudflare-workers-ai")],
  ["@orbit/ai/providers/deepinfra", () => import("@orbit/ai/providers/deepinfra")],
  ["@orbit/ai/providers/deepseek", () => import("@orbit/ai/providers/deepseek")],
  ["@orbit/ai/providers/digitalocean", () => import("@orbit/ai/providers/digitalocean")],
  ["@orbit/ai/providers/fireworks", () => import("@orbit/ai/providers/fireworks")],
  ["@orbit/ai/providers/google", () => import("@orbit/ai/providers/google")],
  ["@orbit/ai/providers/google-vertex", () => import("@orbit/ai/providers/google-vertex")],
  ["@orbit/ai/providers/google-vertex/gemini", () => import("@orbit/ai/providers/google-vertex/gemini")],
  ["@orbit/ai/providers/google-vertex/chat", () => import("@orbit/ai/providers/google-vertex/chat")],
  ["@orbit/ai/providers/google-vertex/responses", () => import("@orbit/ai/providers/google-vertex/responses")],
  ["@orbit/ai/providers/google-vertex/messages", () => import("@orbit/ai/providers/google-vertex/messages")],
  ["@orbit/ai/providers/groq", () => import("@orbit/ai/providers/groq")],
  ["@orbit/ai/providers/meta/chat", () => import("@orbit/ai/providers/meta/chat")],
  ["@orbit/ai/providers/meta/messages", () => import("@orbit/ai/providers/meta/messages")],
  ["@orbit/ai/providers/meta/responses", () => import("@orbit/ai/providers/meta/responses")],
  ["@orbit/ai/providers/minimax/chat", () => import("@orbit/ai/providers/minimax/chat")],
  ["@orbit/ai/providers/minimax/messages", () => import("@orbit/ai/providers/minimax/messages")],
  ["@orbit/ai/providers/minimax/responses", () => import("@orbit/ai/providers/minimax/responses")],
  ["@orbit/ai/providers/mistral", () => import("@orbit/ai/providers/mistral")],
  ["@orbit/ai/providers/moonshot/chat", () => import("@orbit/ai/providers/moonshot/chat")],
  ["@orbit/ai/providers/moonshot/messages", () => import("@orbit/ai/providers/moonshot/messages")],
  ["@orbit/ai/providers/moonshot/responses", () => import("@orbit/ai/providers/moonshot/responses")],
  ["@orbit/ai/providers/openai", () => import("@orbit/ai/providers/openai")],
  ["@orbit/ai/providers/openai/chat", () => import("@orbit/ai/providers/openai/chat")],
  ["@orbit/ai/providers/openai/responses", () => import("@orbit/ai/providers/openai/responses")],
  ["@orbit/ai/providers/openai-compatible", () => import("@orbit/ai/providers/openai-compatible")],
  ["@orbit/ai/providers/openrouter", () => import("@orbit/ai/providers/openrouter")],
  ["@orbit/ai/providers/tachyon", () => import("@orbit/ai/providers/tachyon")],
  ["@orbit/ai/providers/togetherai", () => import("@orbit/ai/providers/togetherai")],
  ["@orbit/ai/providers/zai/chat", () => import("@orbit/ai/providers/zai/chat")],
  ["@orbit/ai/providers/zai-coding-plan/chat", () => import("@orbit/ai/providers/zai-coding-plan/chat")],
  ["@orbit/ai/providers/zai-coding-plan/messages", () => import("@orbit/ai/providers/zai-coding-plan/messages")],
  ["@orbit/ai/providers/zai-coding-plan/responses", () => import("@orbit/ai/providers/zai-coding-plan/responses")],
])

// A compiled binary has no node_modules of its own, so Bun looks a name that the binary does not bundle up in the folder
// it was started in, which can be a repository that is not trusted. The binary never loads a provider from there.
const compiled = typeof Bun !== "undefined" && Bun.isStandaloneExecutable

export const loadPackage = Effect.fn("Provider.loadPackage")(function* (input: string, npm?: Npm.Interface) {
  const specifier = packageName(input)
  const builtin = builtins.get(specifier)
  if (builtin) return yield* importPackage(specifier, specifier, builtin)
  if (specifier.startsWith("file://")) return yield* importPackage(specifier, specifier)
  if (specifier.startsWith("@orbit/ai/")) {
    if (!compiled) return yield* importPackage(specifier, specifier)
    return yield* new LoadError({
      package: specifier,
      cause: new Error(`Provider package ${specifier} is not built in`),
    })
  }
  const resolved = yield* Effect.sync(() => {
    if (compiled) return undefined
    try {
      return import.meta.resolve(specifier)
    } catch {
      return undefined
    }
  })
  if (resolved) return yield* importPackage(specifier, resolved)
  if (!npm) {
    return yield* new LoadError({
      package: specifier,
      cause: new Error(`Provider package ${specifier} is not installed`),
    })
  }
  const parts = specifier.split("/")
  const root = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier)
  const installed = yield* npm.add(root).pipe(Effect.mapError((cause) => new LoadError({ package: specifier, cause })))
  const entrypoint = yield* Effect.try({
    try: () => resolveModule(specifier, installed.directory),
    catch: (cause) => new LoadError({ package: specifier, cause }),
  })
  return yield* importPackage(specifier, entrypoint)
})

/** orbit settings consumed in Core; native packages never receive them. */
const CORE_KEYS = ["chunkTimeout", "compaction", "fetch", "headerTimeout", "timeout", "transport"] as const
const PROVIDER_ONLY_KEYS = ["chunkTimeout", "headerTimeout", "timeout", "transport"] as const

export function nativeSettings(settings: Settings): Settings {
  return Struct.omit(settings, CORE_KEYS)
}

export function modelSettings(settings: Settings | undefined) {
  return settings && Struct.omit(settings, PROVIDER_ONLY_KEYS)
}

const decodeTimeout = Schema.decodeUnknownOption(HttpTimeout)

/** Applied to `headerTimeout` and `chunkTimeout` when provider settings leave them unset or invalid. */
export const DEFAULT_TIMEOUT_MS = 300_000

/** One timeout setting without a default; invalid values are dropped. */
export function timeout(value: unknown) {
  return Option.getOrUndefined(decodeTimeout(value))
}

/** Request timeouts from provider settings, resolved for every route. `timeout` has no default. */
export function timeouts(settings: Readonly<Record<string, unknown>>) {
  return {
    timeout: timeout(settings.timeout),
    headerTimeout: timeout(settings.headerTimeout) ?? DEFAULT_TIMEOUT_MS,
    chunkTimeout: timeout(settings.chunkTimeout) ?? DEFAULT_TIMEOUT_MS,
  }
}

export function mergeOverlay(
  base: Readonly<Record<string, unknown>> | undefined,
  overlay: Readonly<Record<string, unknown>> | undefined,
): Record<string, Json> | undefined {
  if (base === undefined) return overlay && decodeJsonRecord({ ...overlay })
  if (overlay === undefined) return decodeJsonRecord({ ...base })
  return decodeJsonRecord(
    Object.fromEntries(
      new Set([...Object.keys(base), ...Object.keys(overlay)]).values().map((key): [string, unknown] => {
        const left = base[key]
        const right = overlay[key]
        if (right === undefined) return [key, left]
        if (isRecord(left) && isRecord(right)) return [key, mergeOverlay(left, right) ?? {}]
        return [key, right]
      }),
    ),
  )
}

export function mergeHeaders(
  base: Readonly<Record<string, string>> | undefined,
  overlay: Readonly<Record<string, string>> | undefined,
) {
  if (base === undefined) return overlay && { ...overlay }
  if (overlay === undefined) return { ...base }
  return Object.fromEntries(
    [...Object.entries(base), ...Object.entries(overlay)]
      .reduce((result, entry) => {
        result.set(entry[0].toLowerCase(), entry)
        return result
      }, new Map<string, [string, string]>())
      .values(),
  )
}

export const Request = Provider.Request
export type Request = Provider.Request

export const Compaction = Provider.Compaction
export type Compaction = Provider.Compaction

export const Transport = Provider.Transport
export type Transport = Provider.Transport

export const Settings = Provider.Settings
export type Settings = Provider.Settings

export const Info = Provider.Info
export type Info = Provider.Info

export type MutableInfo = DeepMutable<Info>

export { Event } from "@orbit/schema/provider"

/** Provider metadata owns its drafts; model definitions remain immutable inputs. */
export type Definition = {
  readonly provider: Info
  readonly models: ReadonlyMap<Model.ID, Model.Info>
  readonly sourceConnection?: IntegrationConnection.Info
}

export interface Editor {
  readonly list: () => readonly Definition[]
  readonly get: (providerID: ID) => Definition | undefined
  readonly add: (definition: {
    readonly info: Info
    readonly models: readonly Model.Info[]
    readonly sourceConnection?: IntegrationConnection.Info
  }) => void
  readonly update: (providerID: ID, update: (provider: MutableInfo) => void) => void
  readonly remove: (providerID: ID) => void
  readonly models: {
    readonly set: (providerID: ID, models: readonly Model.Info[]) => void
    readonly update: (providerID: ID, modelID: Model.ID, update: (model: DeepMutable<Model.Info>) => void) => void
    readonly remove: (providerID: ID, modelID: Model.ID) => void
  }
}

export interface Snapshot {
  readonly records: ReadonlyMap<ID, Definition>
  readonly available: readonly Definition[]
  readonly providers: readonly Info[]
}

export interface Interface extends State.Transformable<Editor> {
  readonly get: (providerID: ID) => Effect.Effect<Info | undefined>
  readonly all: () => Effect.Effect<readonly Info[]>
  readonly available: () => Effect.Effect<readonly Info[]>
  /** Internal definition/access snapshot; raw model inventories never cross the HTTP API. */
  readonly snapshot: () => Effect.Effect<Snapshot>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/Provider") {}

// Every location references the same index for a shared immutable definition array.
const definitions = new WeakMap<readonly Model.Info[], Map<ID, ReadonlyMap<Model.ID, Model.Info>>>()
function index(providerID: ID, models: readonly Model.Info[]) {
  const indexes = definitions.get(models) ?? new Map<ID, ReadonlyMap<Model.ID, Model.Info>>()
  const cached = indexes.get(providerID)
  if (cached) return cached
  // Model shares these definitions without copying, so a foreign definition takes this provider's identity here.
  const result = freeze(
    new Map(models.map((model) => [model.id, model.providerID === providerID ? model : { ...model, providerID }])),
    true,
  )
  indexes.set(providerID, result)
  definitions.set(models, indexes)
  return result
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const integrations = yield* Integration.Service
    const location = yield* Location.Service
    const state = State.create<
      Map<
        ID,
        {
          provider: MutableInfo
          models: ReadonlyMap<Model.ID, Model.Info>
          sourceConnection?: IntegrationConnection.Info
        }
      >,
      Editor
    >({
      name: "provider",
      initial: () => new Map(),
      editor: (records) => {
        const maps = new WeakSet<ReadonlyMap<Model.ID, Model.Info>>()
        const models = new WeakSet<Model.Info>()
        const entry = (id: ID) => {
          const current = records.get(id)
          if (current) return current
          const added = { provider: Info.empty(id) as MutableInfo, models: new Map<Model.ID, Model.Info>() }
          records.set(id, added)
          maps.add(added.models)
          return added
        }
        const writable = (id: ID) => {
          const record = entry(id)
          if (maps.has(record.models)) return record.models as Map<Model.ID, Model.Info>
          const owned = new Map(record.models)
          record.models = owned
          maps.add(owned)
          return owned
        }
        return {
          list: () => Array.from(records.values()),
          get: (id) => records.get(id),
          add: (definition) => {
            records.set(definition.info.id, {
              provider: structuredClone(definition.info) as MutableInfo,
              models: index(definition.info.id, definition.models),
              sourceConnection: definition.sourceConnection,
            })
          },
          update: (id, update) => {
            const record = entry(id)
            update(record.provider)
            record.provider.id = id
            AISDKNative.rewrite(record.provider, {
              specifier: record.provider.package,
              providerID: id,
              canonical: record.provider.canonical,
            })
          },
          remove: (id) => {
            records.delete(id)
          },
          models: {
            set: (id, values) => {
              entry(id).models = index(id, values)
            },
            update: (providerID, modelID, update) => {
              const record = entry(providerID)
              const target = writable(providerID)
              const current = target.get(modelID)
              const model = // An earlier add/set can publish and freeze an owned model within this fold.
                (
                  current && models.has(current) && !Object.isFrozen(current)
                    ? current
                    : current
                      ? structuredClone(current)
                      : Model.Info.default(providerID, modelID)
                ) as DeepMutable<Model.Info>
              update(model)
              model.id = modelID
              model.providerID = providerID
              AISDKNative.rewrite(model, {
                specifier: model.package ?? record.provider.package,
                providerID,
                canonical: model.canonical ?? record.provider.canonical,
                modelID: model.modelID ?? modelID,
              })
              models.add(model)
              target.set(modelID, model)
            },
            remove: (providerID, modelID) => {
              if (!records.has(providerID)) return
              writable(providerID).delete(modelID)
            },
          },
        }
      },
      notify: () => notify,
    })
    // Registrations may outlive a borrowed service layer; their later disposal must
    // not query dependencies that have already closed.
    yield* Effect.addFinalizer(() => State.shutdown(state.reload()))
    let cached: { records: Snapshot["records"]; value: Snapshot } | undefined
    const snapshot = Effect.fn("Provider.snapshot")(function* () {
      while (true) {
        const revision = integrations.revision()
        const records = state.get()
        // Connection presence decides availability; resolving OAuth tokens belongs to execution.
        const connections = yield* integrations.list()
        // Either fold can disable a plugin that also contributed to the other domain.
        if (revision !== integrations.revision() || records !== state.get()) continue
        const byID = new Map(connections.map((integration) => [integration.id, integration]))
        const available = Array.from(records.values()).filter((record) => {
          if (record.provider.activation === "disabled") return false
          const integration = byID.get(record.provider.integrationID ?? Integration.ID.make(record.provider.id))
          // Never combine the previous account's discovered endpoints/models with a new connection.
          if (
            record.sourceConnection &&
            IntegrationConnection.key(record.sourceConnection) !==
              IntegrationConnection.key(integration?.connections[0])
          )
            return false
          if (record.provider.activation === "enabled") return true
          if (integration?.connections.length) return true
          return record.provider.integrationID === undefined && !integration
        })
        // A credential change that leaves the same definitions available is not a catalog change.
        if (
          cached?.records === records &&
          cached.value.available.length === available.length &&
          cached.value.available.every((record, index) => record === available[index])
        )
          return cached.value
        const value = freeze({ records, available, providers: available.map((record) => record.provider) }, true)
        cached = { records, value }
        return value
      }
    })
    let published: Snapshot | undefined
    const notify: Effect.Effect<void> = Effect.gen(function* () {
      const value = yield* snapshot()
      if (value === published) return
      published = value
      yield* bus.publish(
        Provider.Event.Updated,
        {},
        {
          location: { directory: location.directory, workspaceID: location.workspaceID },
        },
      )
    })
    yield* bus.subscribe([Integration.Event.Updated, Credential.Event.Updated, Credential.Event.Switched]).pipe(
      Stream.runForEach(() => notify),
      Effect.forkScoped({ startImmediately: true }),
    )
    return Service.of({
      transform: state.transform,
      reload: state.reload,
      get: Effect.fn("Provider.get")((id) => Effect.sync(() => freeze(state.get().get(id)?.provider, true))),
      all: Effect.fn("Provider.all")(() =>
        Effect.sync(() => Array.from(state.get().values(), (record) => freeze(record.provider, true))),
      ),
      available: Effect.fn("Provider.available")(() => snapshot().pipe(Effect.map((value) => value.providers))),
      snapshot,
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Bus.node, Integration.node, Location.node] })

const importPackage = Effect.fn("Provider.importPackage")(function* (
  specifier: string,
  entrypoint: string,
  load = () => importModule(entrypoint),
) {
  const module = yield* Effect.tryPromise({
    try: () => {
      const existing = packages.get(entrypoint)
      if (existing) return existing
      const loaded = load()
      packages.set(entrypoint, loaded)
      return loaded
    },
    catch: (cause) => new LoadError({ package: specifier, cause }),
  })
  if (typeof module !== "object" || module === null || typeof (module as { model?: unknown }).model !== "function") {
    return yield* new LoadError({
      package: specifier,
      cause: new Error(`Provider package ${specifier} does not export model(modelID, settings)`),
    })
  }
  return module as ProviderPackageDefinition
})
