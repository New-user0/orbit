import type { Orbit } from "@orbit/client"

/**
 * The server's model list, once it has stopped changing: providers such as Ollama are discovered after the server
 * starts, so a first read can be empty. Returns as soon as `target` (provider/model) appears, and after 15 seconds
 * at most.
 */
export async function settledModels(client: ReturnType<typeof Orbit.make>, target?: string) {
  const deadline = Date.now() + 15_000
  const poll = async (
    previous: string,
    stable: number,
  ): Promise<Awaited<ReturnType<typeof client.model.list>>["data"]> => {
    const current = (await client.model.list({ location: { directory: process.cwd() } })).data
    const key = current.map((item) => `${item.providerID}/${item.id}`).join("\n")
    const found = target === undefined ? undefined : current.some((item) => `${item.providerID}/${item.id}` === target)
    const settled = found ?? (key === previous && current.length > 0 && stable >= 2)
    if (settled || Date.now() > deadline) return current
    await Bun.sleep(250)
    return poll(key, key === previous ? stable + 1 : 0)
  }
  return poll("", 0)
}
