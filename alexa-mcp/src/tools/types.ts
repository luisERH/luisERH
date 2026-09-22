import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Só o que os módulos de ferramenta usam do servidor MCP. */
export type ToolServer = Pick<McpServer, "registerTool">;
