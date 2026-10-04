import type { OrbitEvent } from "@orbit/client"
import { useClient } from "./client"

type EventMetadata = {
  directory: string | undefined
}
type OrbitEventMap = { [Type in OrbitEvent["type"]]: Extract<OrbitEvent, { type: Type }> }

export function useEvent() {
  const client = useClient()

  function subscribe(handler: (event: OrbitEvent, metadata: EventMetadata) => void) {
    return client.event.listen(({ details }) => {
      if (details.type === "server.connected") return
      handler(details, { directory: details.location?.directory })
    })
  }

  function on<T extends OrbitEvent["type"]>(
    type: T,
    handler: (event: OrbitEventMap[T], metadata: EventMetadata) => void,
  ) {
    return client.event.on(type, (event) => {
      handler(event, { directory: event.location?.directory })
    })
  }

  return {
    subscribe,
    on,
  }
}
