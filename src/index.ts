#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { promises as fs } from 'fs';
import { join } from 'path';

import { EndpointWrapper } from "./endpoint_wrapper.js";
import { parseConfig } from "./config.js";

// Parse configuration
const config = parseConfig();

// Change to configured working directory
process.chdir(config.workDir);

// Create a map to store endpoints by their tool names
const endpoints = new Map();

for (const spacePath of config.spacePaths) {
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
    version: "0.3.1",
  },
  {
    capabilities: {
      tools: {},
      prompts: {},
      resources: {
        list: true,
      },
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
  const endpoint = endpoints.get(request.params.name);

  if (!endpoint) {
    throw new Error(`Unknown tool: ${request.params.name}`);
  }
  try {
    return await endpoint.call(request, server);
  } catch (error) {
    if (error instanceof Error) {
      return {
        content: [
          {
            type: `text`,
            text: `mcp-hfspace error: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
    throw error;
  }
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
  const endpoint = endpoints.get(promptName);

  if (!endpoint) {
    throw new Error(`Unknown prompt: ${promptName}`);
  }

  return await endpoint.getPromptTemplate(request.params.arguments);
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  try {
    const files = await fs.readdir(config.workDir);
    const resources = files.map(file => ({
      uri: `file://${join(config.workDir, file)}`,
      name: file,
      type: 'file'
    }));
    return { resources };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to list resources: ${error.message}`);
    }
    throw error;
  }
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
