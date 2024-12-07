#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { EndpointWrapper } from "./endpoint_wrapper.js";

// Get the HuggingFace space paths from command line arguments
let args = process.argv.slice(2);
if (args.length < 1) {
  args = ["black-forest-labs/FLUX.1-schnell"]; // batteries included
/*  console.error(
    "Error: At least one HuggingFace space path is required (format: vendor/space or vendor/space/endpoint)"
  );
  process.exit(1);*/
}

// Create a map to store endpoints by their tool names
const endpoints = new Map();


// Initialize all endpoints
for (const spacePath of args) {
  try {
    const endpoint = await EndpointWrapper.createEndpoint(spacePath);
    endpoints.set(endpoint.toolDefinition().name, endpoint);
  } catch (e) {
    if (e instanceof Error) {
      console.error(`Error loading ${spacePath}: ${e.message}`);
    } else {
      throw e;
    }
    continue;
  }
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
    tools: Array.from(endpoints.values()).map((endpoint) =>
      endpoint.toolDefinition()
    ),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const endpoint = endpoints.get(toolName);

  if (!endpoint) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  const progressToken = request.params._meta?.progressToken as
    | string
    | number
    | undefined;
  const parameters = request.params.arguments as Record<string, any>;
  const normalizedToken =
    typeof progressToken === "number"
      ? progressToken.toString()
      : progressToken;

  return await endpoint.handleToolCall(parameters, normalizedToken, server);
});

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: Array.from(endpoints.values()).map((endpoint) =>
      endpoint.promptDefinition()
    ),
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {

  const promptName = request.params.name;
  const endpoint = Array.from(endpoints.values()).find(
    (ep) => ep.promptName() === promptName
  );

  if (!endpoint) {
    throw new Error(`Unknown prompt: ${promptName}`);
  }

  return await endpoint.getPromptTemplate(request.params.arguments);
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
