import { Plugin, PluginContextProvider, usePlugin } from "@orbit/plugin/tui"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"

ensureRuntimePluginSupport({
  additional: {
    "@orbit/plugin/tui": { Plugin, PluginContextProvider, usePlugin },
  },
})
