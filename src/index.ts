#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  CallToolResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { EndpointWrapper } from "./EndpointWrapper.js";

// Get the HuggingFace space name from command line arguments
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("Error: HuggingFace space name is required as first argument");
  process.exit(1);
}

const spaceName = args[0];
const endpointName = args[1];
const selectedEndpoint = await EndpointWrapper.createEndpoint(
  spaceName,
  endpointName
);

if (!selectedEndpoint) {
  throw new Error("No valid endpoints found in the API");
}

// Create MCP server
const server = new Server(
  {
    name: "mcp-hfspace",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: { listChanged: true },
      prompts: {},
      resources: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [selectedEndpoint.toToolDefinition(spaceName)],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const progressToken = request.params._meta?.progressToken as
    | string
    | number
    | undefined;
  const parameters = request.params.arguments as Record<string, any>;
  const normalizedToken =
    typeof progressToken === "number"
      ? progressToken.toString()
      : progressToken;
  return await selectedEndpoint.handleToolCall(
    parameters,
    normalizedToken,
    server
  );
});

/**
 * Handler that lists available prompts.
 * Exposes a single "summarize_notes" prompt that summarizes all notes.
 */
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: "summarize_notes",
        description: "Summarize all notes",
      },
    ],
  };
});

/**
 * Handler for the summarize_notes prompt.
 * Returns a prompt that requests summarization of all notes, with the notes' contents embedded as resources.
 */
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  if (request.params.name !== "summarize_notes") {
    throw new Error("Unknown prompt");
  }

  const message = undefined === process.env.HF_TOKEN ? "foo" : "bar";

  return {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Please summarize the ${message} following notes:`,
        },
      },
    ],
  };
});

/**
 * Start the server using stdio transport.
 * This allows the server to communicate via standard input/output streams.
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
