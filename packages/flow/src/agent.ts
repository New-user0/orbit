import type { OrbitClient } from "@orbit/client"
import type { ErrorClass, Usage } from "./workflow.js"

// One attempt of one agent node: a fresh Orbit session in the node's directory, one prompt, then the final reply,
// usage and error read back from the session.

export interface Attempt {
  readonly session: string
  readonly text: string
  readonly usage: Usage
  readonly error?: { readonly class: ErrorClass; readonly message: string }
}

export async function attempt(
  client: OrbitClient,
  input: {
    readonly directory: string
    readonly title: string
    readonly prompt: string
    readonly model?: string
    readonly agent?: string
    readonly timeout?: number
    /** Continue this session instead of starting one; its model and agent stay as they are. */
    readonly session?: string
    /** Called once the session exists, before any action can ask for permission. */
    readonly started: (session: string) => void
  },
): Promise<Attempt> {
  if (input.model && !input.session) {
    const models = await available(client, input.directory, input.model)
    if (!models.includes(input.model)) {
      const provider = input.model.split("/")[0]
      const same = models.filter((item) => item.startsWith(`${provider}/`))
      return {
        session: "",
        text: "",
        usage: {},
        error: {
          class: "invalid",
          message: `Model ${input.model} is not available. ${
            same.length > 0
              ? `Available ${provider} models: ${same.join(", ")}.`
              : `Provider ${provider} has no models here.`
          } \`orb models\` lists every model.`,
        },
      }
    }
  }
  const session = input.session
    ? { id: input.session }
    : await client.session.create({
        title: input.title,
        location: { directory: input.directory },
        ...(input.model ? { model: modelRef(input.model) } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
      })
  input.started(session.id)
  // Newest first, so a long session's latest reply is always in the page; on a continued session, only messages
  // that were not there before this prompt count toward its reply and usage.
  const recent = () => client.message.list({ sessionID: session.id, limit: 200, order: "desc" })
  const before = new Set(input.session ? (await recent()).data.map((message) => message.id) : [])
  await client.session.prompt({ sessionID: session.id, text: input.prompt, delivery: "steer" })
  const finished = await waitFor(client.session.wait({ sessionID: session.id }), input.timeout)
  if (!finished) {
    await client.session.interrupt({ sessionID: session.id }).catch(() => undefined)
    return {
      session: session.id,
      text: "",
      usage: {},
      error: { class: "timeout", message: `No result within ${input.timeout} ms` },
    }
  }
  const assistant = (await recent()).data
    .filter((message) => !before.has(message.id))
    .toReversed()
    .flatMap((message) => (message.type === "assistant" ? [message] : []))
  const last = assistant.at(-1)
  return {
    session: session.id,
    text: (last?.content ?? [])
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n")
      .trim(),
    usage: {
      cost: assistant.reduce((total, message) => total + (message.cost ?? 0), 0),
      input: assistant.reduce((total, message) => total + (message.tokens?.input ?? 0), 0),
      output: assistant.reduce((total, message) => total + (message.tokens?.output ?? 0), 0),
    },
    ...(last?.error
      ? { error: { class: classify(last.error.type), message: last.error.message } }
      : last
        ? {}
        : {
            error: {
              class: "unknown" as const,
              message: input.model
                ? "The agent produced no reply"
                : 'The agent produced no reply. No model was set for it; set `model` on the agent, or "model" in orbit.json.',
            },
          }),
  }
}

export function modelRef(model: string) {
  const separator = model.indexOf("/")
  if (separator <= 0) throw new Error(`Model must be provider/model, got ${model}`)
  return { providerID: model.slice(0, separator), id: model.slice(separator + 1) }
}

/** Map the session's structured error type onto the classes retry policies are written in. */
export function classify(type: string): ErrorClass {
  if (type === "provider.rate-limit") return "rate-limit"
  if (type === "provider.internal" || type === "provider.transport" || type === "provider.invalid-output")
    return "transient"
  if (type === "provider.timeout") return "timeout"
  if (type === "provider.auth") return "auth"
  if (type === "provider.quota") return "quota"
  if (type === "provider.content-filter") return "content"
  if (type === "provider.invalid-request" || type === "provider.no-route" || type === "provider.unsupported-operation")
    return "invalid"
  if (type === "permission.rejected") return "permission"
  return "unknown"
}

function waitFor(promise: Promise<unknown>, timeout: number | undefined) {
  if (!timeout) return promise.then(() => true)
  return Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeout)),
  ])
}

// The server's model list can come before every provider has loaded, so a missing model is only reported once the
// list has stopped changing. A list that contains the model is cached for the rest of the run.
const settled = new WeakMap<OrbitClient, ReadonlyArray<string>>()

async function available(client: OrbitClient, directory: string, model: string) {
  const known = settled.get(client)
  if (known?.includes(model)) return known
  const deadline = Date.now() + 15_000
  const poll = async (previous: string, stable: number): Promise<ReadonlyArray<string>> => {
    const current = (await client.model.list({ location: { directory } })).data.map(
      (item) => `${item.providerID}/${item.id}`,
    )
    const key = current.join("\n")
    if (current.includes(model) || (key === previous && current.length > 0 && stable >= 2) || Date.now() > deadline)
      return current
    await Bun.sleep(250)
    return poll(key, key === previous ? stable + 1 : 0)
  }
  const models = await poll("", 0)
  if (models.includes(model)) settled.set(client, models)
  return models
}
