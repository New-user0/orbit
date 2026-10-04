import type { EventApi } from "@orbit/client/effect/api"

export interface EventDomain extends Pick<EventApi<unknown>, "subscribe"> {}
