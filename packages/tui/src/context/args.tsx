import { mergeProps } from "solid-js"
import { createSimpleContext } from "./helper"

export interface Args {
  model?: string
  agent?: string
  prompt?: string
  continue?: boolean
  sessionID?: string
  newSessionID?: string
  fork?: boolean
  /** Open the session list with this text typed into its search (`--resume`); an empty value shows the whole list. */
  resume?: string
  auto?: boolean
}

export const { use: useArgs, provider: ArgsProvider } = createSimpleContext({
  name: "Args",
  init: (props: Args) => {
    // The first new session created from home takes this ID; later ones mint their own.
    let pending = props.newSessionID
    return mergeProps(props, {
      takeNewSessionID() {
        const id = pending
        pending = undefined
        return id
      },
      restoreNewSessionID(id: string) {
        pending ??= id
      },
    })
  },
})
