import { Plugin } from "@orbit/plugin/tui"
import { TrustIndicator } from "../../component/trust-indicator"
import { useTrust } from "../../context/trust"

export default Plugin.define({
  id: "orbit.prompt.trust",
  setup(context) {
    // The prompt's footer shows on Home and in every session, so the folder in view says so wherever it is.
    context.ui.slot({
      append: "prompt.footer.status",
      render: () => {
        const trust = useTrust()
        return <TrustIndicator status={trust.status()} onOpen={trust.open} />
      },
    })
  },
})
