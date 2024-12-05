#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { EndpointWrapper } from "./EndpointWrapper.js";

// Get the HuggingFace space paths from command line arguments
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("Error: At least one HuggingFace space path is required (format: vendor/space or vendor/space/endpoint)");
  process.exit(1);
}

// Create a map to store endpoints by their tool names
const endpoints = new Map();

// Initialize all endpoints
for (const spacePath of args) {
  const endpoint = await EndpointWrapper.createEndpoint(spacePath);
  if (!endpoint) {
    console.error(`Error: No valid endpoint found for ${spacePath}`);
    continue;
  }
  endpoints.set(endpoint.toolDefinition().name, endpoint);
}

if (endpoints.size === 0) {
  throw new Error("No valid endpoints found in any of the provided spaces");
}

// Create MCP server
const server = new Server(
  {
    name: "mcp-hfspace",
    version: "0.2.0",
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
    tools: Array.from(endpoints.values()).map(endpoint => endpoint.toolDefinition()),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const endpoint = endpoints.get(toolName);
  
  if (!endpoint) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  const progressToken = request.params._meta?.progressToken as string | number | undefined;
  const parameters = request.params.arguments as Record<string, any>;
  const normalizedToken = typeof progressToken === "number" ? progressToken.toString() : progressToken;
  
  return await endpoint.handleToolCall(parameters, normalizedToken, server);
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

  return {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Please summarize the following notes:`,
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
