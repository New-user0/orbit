import type { OrbitClient } from "@orbit/client"

// A command that was moved to the background outlives the step that started it, and its completion notice starts
// another step. A headless run is not over until each of the session's commands has ended and its notice has been
// answered. The grace bounds a notice that never arrives, for instance one lost with a server restart.
const GRACE_MS = 10_000

export async function waitForBackground(input: {
  client: OrbitClient
  sessionID: string
  location: { readonly directory: string }
  /** True once the run is being ended for another reason (an interrupt, a rejected ask), so waiting is pointless. */
  abandoned: () => boolean
}) {
  const background = new Set<string>()
  let seen = Date.now()
  while (!input.abandoned()) {
    const listed = await input.client.shell
      .list({ location: { directory: input.location.directory } })
      .catch(() => undefined)
    const running = (listed?.data ?? []).filter(
      (item) => item.status === "running" && item.metadata.sessionID === input.sessionID,
    )
    if (running.length > 0) {
      running.forEach((item) => background.add(item.id))
      seen = Date.now()
      await Bun.sleep(500)
      continue
    }
    if (background.size === 0) return
    ;(await noticedShells(input.client, input.sessionID, background)).forEach((id) => background.delete(id))
    if (background.size > 0 && Date.now() - seen > GRACE_MS) return
    if (background.size > 0) {
      await Bun.sleep(250)
      continue
    }
    await input.client.session.wait({ sessionID: input.sessionID })
  }
}

// Shell IDs whose synthetic notice has left the waiting state in the projected history, newest messages first.
async function noticedShells(client: OrbitClient, sessionID: string, wanted: Set<string>) {
  const found: string[] = []
  let cursor: string | undefined
  while (true) {
    const page = await client.message.list(
      cursor ? { sessionID, limit: 200, cursor } : { sessionID, limit: 200, order: "desc" },
    )
    page.data.forEach((message) => {
      if (message.type !== "synthetic" || message.metadata?.source !== "shell" || message.metadata.state === "waiting")
        return
      const id = message.metadata.shellID
      if (typeof id === "string" && wanted.has(id)) found.push(id)
    })
    cursor = page.cursor.next ?? undefined
    if (!cursor || found.length === wanted.size) return found
  }
}
