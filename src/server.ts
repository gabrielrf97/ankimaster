/**
 * MCP Server setup — wires AnkiConnect client to MCP protocol handlers.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { AnkiClient, AnkiConnectionError } from "./anki-client.js";
import { coreToolSchemas, handleCoreTool } from "./tools/core.js";
import {
  intelligenceToolSchemas,
  handleIntelligenceTool,
} from "./tools/intelligence.js";
import { sourceToolSchemas, handleSourceTool } from "./tools/source.js";

const CORE_TOOL_NAMES = new Set(coreToolSchemas.map((t) => t.name));
const INTELLIGENCE_TOOL_NAMES = new Set(
  intelligenceToolSchemas.map((t) => t.name)
);
const SOURCE_TOOL_NAMES = new Set(sourceToolSchemas.map((t) => t.name));

export async function startServer(host: string, port: number) {
  const anki = new AnkiClient({ host, port });

  const server = new Server(
    { name: "ankimaster", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  // ── List Tools ──

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...coreToolSchemas,
      ...intelligenceToolSchemas,
      ...sourceToolSchemas,
    ],
  }));

  // ── Call Tool ──

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Check connection before every call
    try {
      await anki.checkConnection();
    } catch {
      throw new McpError(
        ErrorCode.InternalError,
        "Cannot connect to Anki. Make sure Anki is running with AnkiConnect installed."
      );
    }

    try {
      if (CORE_TOOL_NAMES.has(name)) {
        return handleCoreTool(name, args ?? {}, anki);
      }
      if (INTELLIGENCE_TOOL_NAMES.has(name)) {
        return handleIntelligenceTool(name, args ?? {}, anki);
      }
      if (SOURCE_TOOL_NAMES.has(name)) {
        return handleSourceTool(name, args ?? {}, anki);
      }

      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    } catch (err) {
      if (err instanceof McpError) throw err;

      return {
        content: [
          {
            type: "text",
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  });

  // ── Start ──

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ankimaster running on stdio");

  process.on("SIGINT", async () => {
    await server.close();
    process.exit(0);
  });
}
