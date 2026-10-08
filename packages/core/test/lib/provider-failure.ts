import { isOverloaded } from "@orbit/ai"
import { RequestExecutor } from "@orbit/ai/route"

/** A provider's 529 reply, classified the way the HTTP executor classifies one. */
export const overloaded = (headers?: Record<string, string>) => {
  const failure = RequestExecutor.httpFailure({
    message: "Overloaded",
    status: 529,
    url: "https://api.example.test/v1/messages",
    responseHeaders: headers,
    responseBody: JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
  })
  // The tests that use this say what an overload does, so they must not run on a failure that is something else.
  if (!isOverloaded(failure)) throw new Error("The overload fixture is no longer classified as an overload")
  return failure
}
