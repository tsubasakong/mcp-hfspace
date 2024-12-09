#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { VERSION } from "./version.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { promises as fs } from "fs";
import { join } from "path";

import { EndpointWrapper } from "./endpoint_wrapper.js";
import { parseConfig } from "./config.js";

// Create MCP server
const server = new Server(
  {
    name: "mcp-hfspace",
    version: VERSION,
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
    const resources = [];
    
    for (const file of files) {
      const fullPath = join(config.workDir, file);
      const stats = await fs.lstat(fullPath);
      
      if (stats.isFile()) {
        resources.push({
          uri: `file://./${file}`,
          name: `File: ${file}`,
        });
      }
    }
    
    return { resources };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to list resources: ${error.message}`);
    }
    throw error;
  }
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const resourcename = request.params.uri;
  return {
    contents: [
      {
        uri: request.params.uri,
        text: `Use the file "${request.params.uri}"`,
        mimetype: `text/plain`
      }
    ]
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
