import type { EventApi } from "@orbit/client/promise/api"

export interface EventDomain extends Pick<EventApi, "subscribe"> {}
