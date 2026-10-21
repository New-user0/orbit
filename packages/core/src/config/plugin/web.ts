export * as ConfigWebPlugin from "./web.js"

import { define } from "@orbit/plugin/effect/plugin"
import { Effect } from "effect"
import { Config } from "../../config.js"
import { Tool } from "../../tool.js"
import { ConfigEntryObserver } from "./entry-observer.js"

export const Plugin = define({
  id: "orbit.config.web",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const tools = yield* Tool.Service
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, tools.reload())
    yield* tools.transform((editor) => {
      editor.web({ allowLocal: Config.experimental(loaded.entries, "allow_local_fetch") === true })
    })
  }),
})
