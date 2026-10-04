import { AmazonBedrockPlugin } from "./provider/amazon-bedrock.js"
import { AzurePlugin } from "./provider/azure.js"
import { CloudflareAIGatewayPlugin } from "./provider/cloudflare-ai-gateway.js"
import { CloudflareWorkersAIPlugin } from "./provider/cloudflare-workers-ai.js"
import { CoherePlugin } from "./provider/cohere.js"
import { DigitalOceanPlugin } from "./provider/digitalocean.js"
import { DynamicProviderPlugin } from "./provider/dynamic.js"
import { GatewayPlugin } from "./provider/gateway.js"
import { GithubCopilotPlugin } from "./provider/github-copilot.js"
import { GoogleVertexPlugin } from "./provider/google-vertex.js"
import { LMStudioPlugin } from "./provider/lmstudio.js"
import { ModalPlugin } from "./provider/modal.js"
import { OllamaPlugin } from "./provider/ollama.js"
import { OpenAIPlugin } from "./provider/openai.js"
import { SnowflakeCortexPlugin } from "./provider/snowflake-cortex.js"
import { OpenRouterPlugin } from "./provider/openrouter.js"
import { PerplexityPlugin } from "./provider/perplexity.js"
import { PoePlugin } from "./provider/poe.js"
import { PromptCacheKeyPlugin } from "./provider/prompt-cache-key.js"
import { SapAICorePlugin } from "./provider/sap-ai-core.js"
import { TachyonPlugin } from "./provider/tachyon.js"
import { VercelPlugin } from "./provider/vercel.js"
import { VenicePlugin } from "./provider/venice.js"
import { VLLMPlugin } from "./provider/vllm.js"
import type { PluginInternal } from "./internal.js"

export const ProviderPlugins: PluginInternal.InternalPlugin[] = [
  AmazonBedrockPlugin,
  AzurePlugin,
  CloudflareAIGatewayPlugin,
  CloudflareWorkersAIPlugin,
  CoherePlugin,
  DigitalOceanPlugin,
  GatewayPlugin,
  GithubCopilotPlugin,
  GoogleVertexPlugin,
  LMStudioPlugin,
  ModalPlugin,
  OllamaPlugin,
  SnowflakeCortexPlugin,
  OpenAIPlugin,
  OpenRouterPlugin,
  PerplexityPlugin,
  PoePlugin,
  PromptCacheKeyPlugin,
  SapAICorePlugin,
  TachyonPlugin,
  VercelPlugin,
  VenicePlugin,
  VLLMPlugin,
  DynamicProviderPlugin,
]
