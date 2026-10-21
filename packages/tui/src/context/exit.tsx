import { createSimpleContext } from "./helper"

export type Exit = (reason?: unknown) => void

/**
 * The terminal UI ended because the person did not trust the folder it started in. It is not an error, so nothing is
 * printed for it, and the process exits with `status`: 1 for Exit or Escape on the question, as the reference does.
 */
export class TrustDeclined {
  constructor(readonly status: 0 | 1) {}
}

/** The status the process exits with for the reason the terminal UI ended with, when that reason has one. */
export function exitStatus(reason: unknown) {
  return reason instanceof TrustDeclined ? reason.status : undefined
}

export const { use: useExit, provider: ExitProvider } = createSimpleContext({
  name: "Exit",
  init: (input: { exit: Exit }) => input.exit,
})
