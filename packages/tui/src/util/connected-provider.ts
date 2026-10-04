import type { IntegrationInfo } from "@orbit/client"

export function hasConnectedProvider(integrations: readonly Pick<IntegrationInfo, "connections">[]) {
  return integrations.some((integration) => integration.connections.length > 0)
}
