#!/usr/bin/env node
/**
 * ankimaster — Anki MCP server with learning intelligence
 * and source-to-cards pipeline.
 */

import { startServer } from "./server.js";

function parseArgs() {
  const args = process.argv.slice(2);

  const portIdx = args.indexOf("--port");
  const port =
    portIdx !== -1 && args[portIdx + 1]
      ? parseInt(args[portIdx + 1], 10)
      : 8765;

  if (Number.isNaN(port) || port < 1 || port > 65535) {
    console.error("Invalid port. Provide a number between 1-65535.");
    process.exit(1);
  }

  const hostIdx = args.indexOf("--host");
  const host =
    hostIdx !== -1 && args[hostIdx + 1] ? args[hostIdx + 1] : "localhost";

  return { host, port };
}

const { host, port } = parseArgs();
startServer(host, port).catch((err) => {
  console.error("Failed to start ankimaster:", err);
  process.exit(1);
});
