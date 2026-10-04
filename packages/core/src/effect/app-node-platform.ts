import { LLMClient, RequestExecutor } from "@orbit/ai/route"
import { Socket } from "effect/unstable/socket"
import { makeGlobalNode } from "@orbit/util/effect/app-node"
import { httpClient } from "@orbit/util/effect/app-node-platform"
import { WebSocketConstructor } from "./websocket-constructor.js"

export const requestExecutor = makeGlobalNode({
  service: RequestExecutor.Service,
  layer: RequestExecutor.layer,
  deps: [httpClient],
})

export const llmClient = makeGlobalNode({ service: LLMClient.Service, layer: LLMClient.layer, deps: [requestExecutor] })

export const webSocketConstructor = makeGlobalNode({
  service: Socket.WebSocketConstructor,
  layer: WebSocketConstructor.layer,
  deps: [],
})

export * as LayerNodePlatform from "./app-node-platform.js"
