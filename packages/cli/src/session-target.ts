import type { LocationGetOutput, ModelRef, OrbitClient, SessionInfo } from "@orbit/client/promise"
import { Model } from "@orbit/schema/model"
import { errorMessage } from "./util/error"

const SESSION_PAGE_LIMIT = 50

export type SessionTarget = {
  session: SessionInfo
  location: LocationGetOutput
  model: ModelRef | undefined
  agent: string | undefined
  resume: boolean
}

export type SessionTargetPreparation = (input: {
  client: OrbitClient
  location: LocationGetOutput
  session: SessionInfo | undefined
  model: ModelRef | undefined
  agent: string | undefined
  signal?: AbortSignal
}) => Promise<{ model: ModelRef | undefined; agent: string | undefined }>

export class SessionTargetMutationError extends Error {
  override readonly name = "SessionTargetMutationError"

  constructor(cause: unknown) {
    super(errorMessage(cause), { cause })
  }
}

export async function resolveSessionTarget(input: {
  client: OrbitClient
  location?: { directory?: string; workspace?: string }
  continue?: boolean
  session?: string
  /** The session has to exist already: a miss fails with "Session not found" and creates nothing. */
  mustExist?: boolean
  fork?: boolean
  model?: ModelRef
  agent?: string
  environment?: Readonly<Record<string, string>>
  prepare: SessionTargetPreparation
  signal?: AbortSignal
}): Promise<SessionTarget> {
  const selection = await selectSession(input)
  const selected = selection.session
  const location =
    selection.location ??
    (await resolveLocation(
      input.client,
      selected ? { directory: selected.location.directory } : input.location,
      input.signal,
    ))
  const prepared = await input.prepare({
    client: input.client,
    location,
    session: selected,
    model: input.model ?? selected?.model,
    agent: input.agent ?? selected?.agent,
    signal: input.signal,
  })
  const session =
    selected ??
    (await input.client.session
      .create(
        {
          id: input.session,
          agent: prepared.agent,
          model: prepared.model,
          location: { directory: location.directory },
        },
        ...requestOptions(input.signal),
      )
      .catch((error) => {
        throw new SessionTargetMutationError(error)
      }))
  if (input.environment !== undefined)
    await input.client.session
      .environment({ sessionID: session.id, variables: input.environment }, ...requestOptions(input.signal))
      .catch((error) => {
        throw new SessionTargetMutationError(error)
      })
  return {
    session,
    location,
    model: prepared.model,
    agent: prepared.agent ?? session.agent,
    resume: selected !== undefined,
  }
}

export function parseSessionTargetModel(value?: string): ModelRef | undefined {
  if (!value) return
  const model = Model.Ref.parse(value)
  return { providerID: model.providerID, id: model.id, variant: model.variant }
}

async function selectSession(input: {
  client: OrbitClient
  location?: { directory?: string }
  continue?: boolean
  session?: string
  mustExist?: boolean
  fork?: boolean
  signal?: AbortSignal
}) {
  const explicit = input.session ? await findSession(input.client, input.session, input.signal) : undefined
  if (input.session && !explicit) {
    if (input.fork || input.mustExist) throw new Error("Session not found")
    return { session: undefined }
  }
  if (explicit)
    return {
      session: input.fork
        ? await input.client.session
            .fork({ sessionID: explicit.id }, ...requestOptions(input.signal))
            .catch((error) => {
              throw new SessionTargetMutationError(error)
            })
        : explicit,
    }
  if (!input.continue) return { session: undefined }

  const location = await resolveLocation(input.client, input.location, input.signal)
  const selected = await latestSession(input.client, location, undefined, input.signal)
  if (!selected) return { session: undefined, location }
  return {
    session: input.fork
      ? await input.client.session.fork({ sessionID: selected.id }, ...requestOptions(input.signal)).catch((error) => {
          throw new SessionTargetMutationError(error)
        })
      : selected,
  }
}

/**
 * The session that `--resume` names in a printed run: the one whose ID is the value, or else the newest session of the
 * folder that matches the value as words. It fails when there is none, so a typo never starts a new session.
 */
export async function findResumeSession(client: OrbitClient, value: string, directory: string, signal?: AbortSignal) {
  if (!value.trim()) throw new Error("--resume needs a session ID or some words to search for")
  const named = /^ses\S*$/.test(value) ? await findSession(client, value, signal) : undefined
  if (named) return named
  const found = await client.session.list(
    { directory, parentID: null, search: value, limit: 1, order: "desc" },
    ...requestOptions(signal),
  )
  const match = found.data[0]
  if (!match) throw new Error("Session not found")
  return match
}

export function findSession(client: OrbitClient, sessionID: string, signal?: AbortSignal) {
  return client.session.get({ sessionID }, ...requestOptions(signal)).catch((error) => {
    if (error && typeof error === "object" && "_tag" in error && error._tag === "SessionNotFoundError") return undefined
    throw error
  })
}

/** The session that `--continue` picks for a folder, resolved the way the run resolves it: through the server's own `location.get`. */
export async function latestSessionOf(client: OrbitClient, directory: string, signal?: AbortSignal) {
  return latestSession(client, await resolveLocation(client, { directory }, signal), undefined, signal)
}

async function latestSession(
  client: OrbitClient,
  location: LocationGetOutput,
  cursor?: string,
  signal?: AbortSignal,
): Promise<SessionInfo | undefined> {
  const page = await client.session.list(
    {
      directory: location.directory,
      parentID: null,
      limit: SESSION_PAGE_LIMIT,
      order: "desc",
      ...(cursor ? { cursor } : {}),
    },
    ...requestOptions(signal),
  )
  const selected = page.data.find((session) => session.location.directory === location.directory)
  if (selected) return selected
  if (!page.cursor.next || page.data.length === 0) return
  return latestSession(client, location, page.cursor.next, signal)
}

function resolveLocation(client: OrbitClient, location?: { directory?: string }, signal?: AbortSignal) {
  if (!location && !signal) return client.location.get()
  if (!location) return client.location.get(undefined, { signal })
  return client.location.get({ location }, ...requestOptions(signal))
}

function requestOptions(signal?: AbortSignal): [] | [{ signal: AbortSignal }] {
  return signal ? [{ signal }] : []
}
