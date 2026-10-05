import { runInteractiveDeferredMode, type RunDeferredInput } from "./runtime"
import { announceTrust } from "./trust.shared"

export type MiniFrontendInput = RunDeferredInput
export type MiniFrontendResult = {
  exitCode: number
}

export async function runMiniFrontend(input: MiniFrontendInput): Promise<MiniFrontendResult> {
  await announceTrust({ sdk: input.sdk, directory: input.directory, write: (text) => input.host.stdout.write(text) })
  await runInteractiveDeferredMode(input)
  return { exitCode: 0 }
}
