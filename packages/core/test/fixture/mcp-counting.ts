import { appendFileSync } from "node:fs"

// A real MCP server that first records each start by appending a byte to the file named by the first argument, so a
// test can tell a server that kept running from one that was restarted.
appendFileSync(process.argv[2], "x")
await import("./mcp-output-schema.ts")
