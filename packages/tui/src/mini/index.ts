import { runInteractiveDeferredMode, type RunDeferredInput } from "./runtime"
import { trustRefusal } from "./trust.shared"

export type MiniFrontendInput = RunDeferredInput
export type MiniFrontendResult = {
  exitCode: number
}

export async function runMiniFrontend(input: MiniFrontendInput): Promise<MiniFrontendResult> {
  // Before the terminal is handed over: a folder that is not trusted, or one the server cannot answer for, ends here.
  const refused = await trustRefusal({ sdk: input.sdk, directory: input.directory })
  if (refused !== undefined) {
    input.host.stderr.write(`${refused}\n`)
    return { exitCode: 1 }
  }
  await runInteractiveDeferredMode(input)
  return { exitCode: 0 }
}
