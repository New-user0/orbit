import { Effect, Option, Schema } from "effect"
import { Headers, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { certificateFailureCode } from "../provider-error.js"
import type { ProviderPackage } from "../provider-package.js"
import { OpenAIChat } from "../protocols/openai-chat.js"
import { Auth } from "../route/auth.js"
import { Route, type RouteDefaultsInput } from "../route/client.js"
import { Endpoint } from "../route/endpoint.js"
import type { HttpHandler, HttpMiddleware } from "../route/executor.js"
import {
  AIError,
  AuthenticationError,
  ProviderConfigurationError,
  ProviderID,
  TransportError,
  type ModelID,
} from "../schema/index.js"
import type { OpenAIProviderOptionsInput } from "./openai-options.js"

// Tachyon is an OpenAI chat-completions gateway behind Apigee. The wire contract is documented in docs/tachyon.md.
export const id = ProviderID.make("tachyon")

export interface Connection {
  /** Chat-completions base URL; `/chat/completions` is appended. */
  readonly baseURL: string
  /** Apigee OAuth token URL, used exactly as given. */
  readonly apigeeURL?: string
  readonly consumerKey?: string
  readonly consumerSecret?: string
  /** Sent as `x-wf-api-key`. */
  readonly apiKey: string
  /** Sent as `x-wf-usecase-id`. */
  readonly usecaseId: string
  /** `false` skips the Apigee token exchange and sends `Bearer dummy`, as the gateway expects without Apigee. */
  readonly useApiGateway?: boolean
  /**
   * Gateway model IDs tried in order when a model fails on the gateway side (TAC006, rate limits, 5xx). Each is sent
   * with its default output-ceiling field.
   */
  readonly fallbackModels?: ReadonlyArray<string>
}

export type LanguageModelOptions = Omit<RouteDefaultsInput, "providerOptions"> &
  Connection & {
    readonly providerOptions?: OpenAIProviderOptionsInput
  }

export type Settings = ProviderPackage.Settings &
  OpenAIProviderOptionsInput &
  Partial<Omit<Connection, "useApiGateway" | "fallbackModels">> & {
    readonly useApiGateway?: boolean | string
    /** A list, or a comma-separated string as an environment variable would give it. */
    readonly fallbackModels?: ReadonlyArray<string> | string
  }

export const route = Route.make({
  id: "tachyon-chat",
  provider: id,
  providerMetadataKey: "tachyon",
  protocol: OpenAIChat.protocol,
  endpoint: Endpoint.path("/chat/completions"),
  framing: OpenAIChat.framing,
})

export const routes = [route]

export const configure = (input: LanguageModelOptions) => {
  const {
    baseURL,
    apigeeURL: _apigeeURL,
    consumerKey: _consumerKey,
    consumerSecret: _consumerSecret,
    apiKey: _apiKey,
    usecaseId: _usecaseId,
    useApiGateway: _useApiGateway,
    fallbackModels,
    ...defaults
  } = input
  const configured = route.with({
    ...defaults,
    endpoint: { baseURL },
    auth: auth(input),
    ...(fallbackModels && fallbackModels.length > 0 ? { transport: fallbackTransport(fallbackModels) } : {}),
  })
  return {
    id,
    model: (modelID: string | ModelID) =>
      configured.model<OpenAIProviderOptionsInput>({
        id: modelID,
        // The gateway rejects a request that carries both ceiling fields, and models disagree on which one they read.
        compatibility: { maxTokensField: maxTokensField(String(modelID)), supportsStore: false },
      }),
    configure,
  }
}

export const model: ProviderPackage.Definition<Settings, OpenAIProviderOptionsInput>["model"] = (
  modelID,
  {
    baseURL,
    apigeeURL,
    consumerKey,
    consumerSecret,
    apiKey,
    usecaseId,
    useApiGateway,
    fallbackModels,
    body,
    headers,
    ...providerOptions
  },
) =>
  configure({
    ...requireConnection({ baseURL, apigeeURL, consumerKey, consumerSecret, apiKey, usecaseId, useApiGateway }),
    fallbackModels: (typeof fallbackModels === "string" ? fallbackModels.split(",") : (fallbackModels ?? []))
      .map((item) => item.trim())
      .filter((item) => item !== ""),
    headers: headers === undefined ? undefined : { ...headers },
    http: body === undefined ? undefined : { body: { ...body } },
    providerOptions,
  }).model(modelID)

/**
 * Claude and most hosted models read `max_tokens`; GPT-5 models read only `max_completion_tokens` and reject
 * `max_tokens`. Configure `compatibility.maxTokensField` on a model to override this default.
 */
export const maxTokensField = (modelID: string) =>
  /^(?:gpt-5|o\d)/i.test(modelID) ? ("max_completion_tokens" as const) : ("max_tokens" as const)

/** Drop cached Apigee tokens so the next request exchanges a fresh one, e.g. after the gateway answers 401. */
export const invalidate = () => tokens.clear()

// Process-wide breaker per gateway model: after repeated gateway-side failures a model is skipped for a while, so
// later requests start with a model that is answering.
const breakerThreshold = 3
const breakerCooldown = 60_000
const breaker = new Map<string, { failures: number; openUntil: number }>()

/** Forget breaker state, e.g. between tests. */
export const resetBreaker = () => breaker.clear()

function fallbackTransport(models: ReadonlyArray<string>): typeof route.transport {
  const base = route.transport
  return {
    ...base,
    prepare: (input) =>
      base.prepare(input).pipe(
        Effect.map((prepared) => {
          const inner = prepared.middleware
          const fallback = fallbackMiddleware(models)
          return {
            ...prepared,
            middleware: (request: HttpClientRequest.HttpClientRequest, handler: HttpHandler) =>
              fallback(request, (next) => (inner ? inner(next, handler) : handler(next))),
          }
        }),
      ),
  }
}

function fallbackMiddleware(models: ReadonlyArray<string>): HttpMiddleware {
  return (request, handler) =>
    Effect.gen(function* () {
      const web = yield* HttpClientRequest.toWeb(request)
      const body = yield* Effect.promise(() => web.text())
      const primary = Option.getOrUndefined(decodeModel(body))?.model
      const all = [...new Set([...(primary ? [primary] : []), ...models])]
      const now = Date.now()
      const closed = all.filter((model) => (breaker.get(model)?.openUntil ?? 0) <= now)
      const candidates = closed.length > 0 ? closed : all
      const attempt = (index: number): Effect.Effect<HttpClientResponse.HttpClientResponse, Error> =>
        Effect.gen(function* () {
          const model = candidates[index] ?? primary ?? ""
          const sent = model === primary ? request : withModel(request, body, model)
          const response = yield* handler(sent)
          if (response.status < 400) {
            breaker.delete(model)
            return response
          }
          const text = yield* response.text
          const replay = HttpClientResponse.fromWeb(
            sent,
            new Response(text, { status: response.status, headers: response.headers }),
          )
          if (!gatewayFailure(response.status, text)) return replay
          const state = breaker.get(model) ?? { failures: 0, openUntil: 0 }
          state.failures++
          if (state.failures >= breakerThreshold) state.openUntil = Date.now() + breakerCooldown
          breaker.set(model, state)
          if (index + 1 >= candidates.length) return replay
          return yield* attempt(index + 1)
        })
      return yield* attempt(0)
    })
}

// Failures that another model may not share: a model crash (TAC006), throttling, or a gateway or backend outage.
// Apigee's missing-header 500 is a configuration error that every model would hit.
function gatewayFailure(status: number, body: string) {
  if (/E50043/.test(body)) return false
  return /TAC006/.test(body) || status === 429 || status >= 500
}

function withModel(request: HttpClientRequest.HttpClientRequest, body: string, model: string) {
  const parsed = Option.getOrElse(decodeBody(body), (): Readonly<Record<string, unknown>> => ({}))
  const { max_tokens, max_completion_tokens, ...rest } = parsed
  const limit = max_tokens ?? max_completion_tokens
  const next = { ...rest, model, ...(limit === undefined ? {} : { [maxTokensField(model)]: limit }) }
  return HttpClientRequest.bodyText(request, JSON.stringify(next), "application/json").pipe(
    HttpClientRequest.setHeaders({ "x-request-id": crypto.randomUUID(), "x-wf-request-date": requestDate() }),
  )
}

const decodeModel = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ model: Schema.String })))
const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))

/** Local time without a zone, with microseconds, as the gateway's Python SDK sends `x-wf-request-date`. */
export const requestDate = (date = new Date()) => {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}000`
}

function auth(input: Connection) {
  return Auth.custom((request) =>
    Effect.gen(function* () {
      const bearer = input.useApiGateway === false ? "dummy" : yield* accessToken(input)
      return Headers.setAll(request.headers, {
        authorization: `Bearer ${bearer}`,
        "x-request-id": crypto.randomUUID(),
        "x-wf-request-date": requestDate(),
        "x-wf-api-key": input.apiKey,
        "x-wf-usecase-id": input.usecaseId,
      })
    }),
  )
}

// One in-flight or cached token per Apigee client, shared by every model and request in the process.
const tokens = new Map<string, Promise<Token>>()
// Refresh this long before expiry, or at 10% of the lifetime when the lifetime is shorter (the SDK's rule).
const refreshMargin = 300_000
const defaultLifetime = 3_600_000

interface Token {
  readonly value: string
  readonly refreshAt: number
}

const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.optional(Schema.Union([Schema.Number, Schema.NumberFromString])),
})
const decodeToken = Schema.decodeUnknownOption(Schema.fromJsonString(TokenResponse))

function tokenKey(input: Pick<Connection, "apigeeURL" | "consumerKey">) {
  return `${input.apigeeURL ?? ""}\n${input.consumerKey ?? ""}`
}

function accessToken(input: Connection) {
  return Effect.tryPromise({
    try: async () => {
      const key = tokenKey(input)
      const cached = tokens.get(key)
      if (cached) {
        const token = await cached.catch(() => undefined)
        if (token && Date.now() < token.refreshAt) return token.value
        if (tokens.get(key) === cached) tokens.delete(key)
      }
      const pending = tokens.get(key) ?? exchange(input)
      tokens.set(key, pending)
      return (
        await pending.catch((error) => {
          if (tokens.get(key) === pending) tokens.delete(key)
          throw error
        })
      ).value
    },
    catch: (cause) =>
      cause instanceof AIError
        ? cause
        : new AIError({
            reason: new TransportError({
              message: `Tachyon token request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
              cause,
              transport: "http",
              operation: "request",
              code: certificateFailureCode(cause),
              url: input.apigeeURL,
              phase: "connect",
              delivery: "not-sent",
            }),
          }),
  })
}

async function exchange(input: Connection): Promise<Token> {
  const response = await fetch(input.apigeeURL ?? "", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${input.consumerKey}:${input.consumerSecret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  })
  const text = await response.text()
  const token = response.ok ? Option.getOrUndefined(decodeToken(text)) : undefined
  if (!token)
    throw new AIError({
      reason: new AuthenticationError({
        message: response.ok
          ? "Tachyon token response has no access_token"
          : `Tachyon token request was rejected with HTTP ${response.status}`,
        body: text,
      }),
    })
  const lifetime = token.expires_in === undefined ? defaultLifetime : token.expires_in * 1000
  const margin = refreshMargin >= lifetime ? lifetime * 0.9 : refreshMargin
  return { value: token.access_token, refreshAt: Date.now() + lifetime - margin }
}

function requireConnection(
  settings: Partial<Omit<Connection, "useApiGateway">> & { useApiGateway?: boolean | string },
) {
  const useApiGateway = !(settings.useApiGateway === false || String(settings.useApiGateway).toLowerCase() === "false")
  const gateway = ["apigeeURL", "consumerKey", "consumerSecret"] as const
  const required = [...(["baseURL", "apiKey", "usecaseId"] as const), ...(useApiGateway ? gateway : [])]
  const missing = required.filter((name) => !settings[name])
  if (missing.length > 0)
    throw new ProviderConfigurationError({
      provider: id,
      message: `Tachyon is missing ${missing.join(", ")}`,
    })
  return {
    baseURL: settings.baseURL ?? "",
    apigeeURL: settings.apigeeURL,
    consumerKey: settings.consumerKey,
    consumerSecret: settings.consumerSecret,
    apiKey: settings.apiKey ?? "",
    usecaseId: settings.usecaseId ?? "",
    useApiGateway,
  }
}

export * as Tachyon from "./tachyon.js"
