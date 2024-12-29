#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { VERSION } from "./version.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import mime from "mime";
import {
  treatAsText,
  claudeSupportedMimeTypes,
  FALLBACK_MIME_TYPE,
} from "./mime_types.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ResourceContentsSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Dirent, promises as fs } from "fs";
import path, { join } from "path";

import { EndpointWrapper } from "./endpoint_wrapper.js";
import { parseConfig } from "./config.js";

const MAX_RESOURCE_SIZE = 1024 * 1024 * 2; // 2MB
const AVAILABLE_RESOURCES = "Available Resources";

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
const endpoints = new Map<string, EndpointWrapper>();

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
    prompts: [
      {
        name: AVAILABLE_RESOURCES,
        description: "List of available resources.",
        arguments: [],
      },
      ...Array.from(endpoints.values()).map((endpoint) =>
        endpoint.promptDefinition()
      ),
    ],
  };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const promptName = request.params.name;

  if (AVAILABLE_RESOURCES === promptName) {
    return availableResourcesPrompt();
  }

  const endpoint = endpoints.get(promptName);

  if (!endpoint) {
    throw new Error(`Unknown prompt: ${promptName}`);
  }

  return await endpoint.getPromptTemplate(request.params.arguments);
});

async function fileToUri(file: Dirent) {
  const fullPath = path.join(file.parentPath || "", file.name);
  const relativePath = path
    .relative(config.workDir, fullPath)
    .replace(/\\/g, "/"); // ensure forward slashes

  // Get file stats
  const stats = await fs.stat(fullPath);

  return {
    uri: `file:./${relativePath}`,
    size: stats.size,
    lastModified: stats.mtime
  };
}

function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

async function availableResourcesPrompt() {
  const files = await fs.readdir(config.workDir, {
    withFileTypes: true,
    recursive: true,
  });

  const fileList = await Promise.all(
    files
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const fileInfo = await fileToUri(entry);
        const mimeType = mime.getType(entry.name) || FALLBACK_MIME_TYPE;

        return {
          uri: fileInfo.uri,
          name: entry.name,
          mimeType,
          size: formatFileSize(fileInfo.size),
          lastModified: fileInfo.lastModified.toISOString()
        };
      })
  );

  const content =
    fileList.length == 0
      ? { type: "text", text: "No resources available." }
      : {
          type: "text",
          text: `
    The following resources are available for tool calls:
| Resource URI | Name | MIME Type | Size | Last Modified |
|--------------|------|-----------|------|---------------|
${fileList.map(f => `| ${f.uri} | ${f.name} | ${f.mimeType} | ${f.size} | ${f.lastModified} |`).join("\n")}
    
Prefer using the Resource URI for tool parameters which require a file input. URLs are also accepted.`.trim(),
        };

  return {
    messages: [
      {
        role: "user",
        content: content,
      },
    ],
  };
}

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  try {
    const files = await fs.readdir(config.workDir, {
      withFileTypes: true,
      recursive: true,
    });
    const supportedFiles = await Promise.all(
      files.map(async (entry) => ({
        entry,
        isSupported: entry.isFile() && (await supported(entry.name)),
      }))
    );

    return {
      resources: await Promise.all(supportedFiles
        .filter(({ isSupported }) => isSupported)
        .map(async ({ entry }) => ({
          uri: (await fileToUri(entry)).uri,
          name: `${entry.name}`,
          mimetype: mime.getType(entry.name) || FALLBACK_MIME_TYPE,
        }))),
    };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to list resources: ${error.message}`);
    }
    throw error;
  }
});

async function supported(filename: string) {
  if (!config.claudeDesktopMode) return true;
  // Check file size before deciding if it's supported
  try {
    const stats = await fs.stat(filename);
    if (stats.size > MAX_RESOURCE_SIZE) return false;
  } catch (error) {
    return false;
  }

  const mimetype = mime.getType(filename);
  if (null === mimetype) return false;
  return claudeSupportedMimeTypes.some((supported) => {
    if (!supported.includes("/*")) return supported === mimetype;

    const supportedMainType = supported.split("/")[0];
    const mainType = mimetype?.split("/")[0];
    return supportedMainType === mainType;
  });
}

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const resourcename = request.params.uri;
  const file = path.basename(resourcename);
  const mimeType = mime.getType(request.params.uri) || FALLBACK_MIME_TYPE;

  const content = treatAsText(mimeType)
    ? { text: await fs.readFile(file, "utf-8") }
    : { blob: (await fs.readFile(file)).toString("base64") };

  return {
    contents: [
      {
        uri: request.params.uri,
        mimeType: mimeType,
        ...content,
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
