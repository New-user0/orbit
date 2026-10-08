import { Server } from "@modelcontextprotocol/server"
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio"

// A stdio server whose tools declare the annotations a client maps onto traits, so the hints reach the client through
// the SDK's own tools/list parsing. A call answers with `chars` copies of "x" (one by default), so a test can shape
// the size of a result. MCP_TRAITS_TITLE replaces the title of `lookup`, for a server that sends hostile text.
const server = new Server({ name: "traits", version: "1.0.0" }, { capabilities: { tools: {} } })

const input = { type: "object", properties: { chars: { type: "number" } } } as const

server.setRequestHandler("tools/list", () =>
  Promise.resolve({
    tools: [
      {
        name: "lookup",
        inputSchema: input,
        title: process.env.MCP_TRAITS_TITLE ?? "Look up",
        annotations: { readOnlyHint: true },
      },
      { name: "remove", inputSchema: input, annotations: { destructiveHint: true } },
      { name: "plain", inputSchema: input },
      {
        name: "local",
        inputSchema: input,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      { name: "untitled", inputSchema: input, title: "", annotations: { title: "  " } },
    ],
  }),
)
server.setRequestHandler("tools/call", (request) =>
  Promise.resolve({
    content: [{ type: "text", text: "x".repeat(Number(request.params.arguments?.chars ?? 1)) }],
  }),
)

await server.connect(new StdioServerTransport())
