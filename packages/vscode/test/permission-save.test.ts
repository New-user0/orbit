import { expect, test } from "bun:test"
import { Orbit } from "@orbit/client"
import type { OrbitEvent } from "@orbit/client"
import { Controller } from "../src/controller"
import type { Item } from "../src/protocol"

// Managed settings can withhold "Always allow": the server then sends no `save` patterns, and the chat must not offer it.
const session = "ses_save"

for (const row of [
  { name: "offers Always allow when the request can be saved", save: ["src/*"], canSave: true },
  { name: "hides Always allow when the request cannot be saved", save: [], canSave: false },
  { name: "hides Always allow when the request has no save patterns", save: undefined, canSave: false },
]) {
  test(row.name, () => {
    const items = new Map<string, Item>()
    const controller = new Controller(
      Orbit.make({ baseUrl: "http://127.0.0.1:9" }),
      "/tmp/none",
      (update) => {
        if (update.type === "item") items.set(update.item.id, update.item)
      },
      () => Promise.resolve("later"),
    )
    controller["session"] = session
    controller.handle({
      id: "evt_1",
      type: "permission.asked",
      created: Date.now(),
      data: { id: "per_1", sessionID: session, action: "Edit", resources: ["a.txt"], save: row.save, metadata: {} },
    } as unknown as OrbitEvent)
    expect(items.get("per_1")).toMatchObject({ type: "permission", canSave: row.canSave })
    controller.dispose()
  })
}
