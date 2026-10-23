import { runInteractiveDeferredMode, type RunDeferredInput, type RunRuntimeDeps } from "./runtime"
import { trustRefusal } from "./trust.shared"

export type MiniFrontendInput = RunDeferredInput
export type MiniFrontendResult = {
  exitCode: number
}

/** `deps` is a seam for tests, as in `runInteractiveDeferredMode`. */
export async function runMiniFrontend(input: MiniFrontendInput, deps?: RunRuntimeDeps): Promise<MiniFrontendResult> {
  // Before the terminal is handed over: a folder that is not trusted, or one the server cannot answer for, ends here.
  const answer = await trustRefusal({ sdk: input.sdk, directory: input.directory })
  if ("root" in answer)
    return runInteractiveDeferredMode({ ...input, root: answer.root }, deps).then(() => ({ exitCode: 0 }))
  input.host.stderr.write(`${answer.refusal}\n`)
  return { exitCode: 1 }
}
