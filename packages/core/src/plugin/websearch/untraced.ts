import { Effect } from "effect"
import { HttpClient } from "effect/unstable/http"

/**
 * A search provider is a third party: it must not receive Orbit's trace context. The client adds `traceparent` and `b3`
 * headers to every request unless this reference is switched off while the request runs, so a provider gets the client
 * through this wrapper and cannot link its requests to one run or to the person's own telemetry.
 */
export const untraced = (http: HttpClient.HttpClient) =>
  HttpClient.transform(http, (response) =>
    response.pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false)),
  )
