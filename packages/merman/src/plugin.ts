import { Plugin } from "@orbit/plugin/tui"
import { createMermaidCodeBlockRenderer } from "./markdown.js"
import { resolveOrbitDiagramPalette } from "./palette.js"

export default Plugin.define({
  id: "orbit.merman",
  setup(context) {
    context.markdown.registerCodeBlockRenderer(
      "mermaid",
      createMermaidCodeBlockRenderer(context.renderer, () => ({
        colors: resolveOrbitDiagramPalette(context.theme, context.themeMode),
      })),
    )
  },
})
