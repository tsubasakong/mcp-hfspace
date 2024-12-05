#!/usr/bin/env node


import { Client, Status } from "@gradio/client";
import type { Payload } from "@gradio/client";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  TextContent,
  ImageContent,
  CallToolResult,
  EmbeddedResource,
} from "@modelcontextprotocol/sdk/types.js";
import { ApiStructure, ApiEndpoint } from "./ApiStructure.js";
import { createProgressNotifier, convertApiToSchema } from "./utils.js";
import { EndpointWrapper } from "./types.js";

// Get the HuggingFace space name from command line arguments
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("Error: HuggingFace space name is required as first argument");
  process.exit(1);
}

const spaceName = args[0];
const endpointName = args[1];
const gradio = await Client.connect(spaceName, { events: ["data", "status"] });
const api = await gradio.view_api() as ApiStructure;

const selectedEndpoint = EndpointWrapper.findPreferred(api, {
  endpointName: endpointName});

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
      tools: {},
      prompts: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [selectedEndpoint.toToolDefinition(spaceName)]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const progressToken = request.params._meta?.progressToken;
  const parameters = request.params.arguments as Record<string, any>;
  const progressNotifier = createProgressNotifier(server);

  try {
    let result: any;
    const submission = gradio.submit(selectedEndpoint.call_path, parameters);

    for await (const msg of submission) {
      if (msg.type === "data") {
        result = msg.data;
      } else if (msg.type === "status" && progressToken) {
        if (msg.stage === "error") {
          throw new Error(`Gradio error: ${msg.message || "Unknown error"}`);
        }
        await progressNotifier.notify(msg, progressToken);
      }
    }

    if (!result) {
      throw new Error("No data received from endpoint");
    }

    return await createToolResult(selectedEndpoint.returns, {
      data: result,
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Error calling endpoint: ${errorMessage}`);
  }
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
          text: "Please summarize the following notes:",
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

// Type definitions for clarity
type GradioOutput = {
  label: string;
  type: string;
  python_type: {
    type: string;
    description: string;
  };
  component: string;
  description?: string;
};

async function createToolResult(
  outputs: GradioOutput[],
  predictResults: Payload
): Promise<CallToolResult> {
  // Get the last result's data
  const resultData = predictResults.data;
  const content: Array<TextContent | ImageContent | EmbeddedResource> = [];

  for (const [index, output] of outputs.entries()) {
    const value = resultData[index];

    try {
      switch (output.component) {
        case "Chatbot":
          content.push({
            type: "text",
            text: `${output.label}: ${value}`,
          });
          break;

        case "Image":
          if (value?.url) {
            const response = await fetch(value.url);
            const mimeType =
              response.headers.get("content-type") || "image/png";
            const arrayBuffer = await response.arrayBuffer();
            const base64Data = Buffer.from(arrayBuffer).toString("base64");

            content.push({
              type: "image",
              data: base64Data,
              mimeType,
            });
          }
          break;

        default:
          // Handle other types (text, numbers, etc)
          if (value !== null && value !== undefined) {
            content.push({
              type: "text",
              text: `${output.label}: ${value}`,
            });
          }
          break;
      }
    } catch (error) {
      // Add error message to content if conversion fails
      content.push({
        type: "text",
        text: `Error converting ${output.label}: ${(error as Error).message}`,
      });
    }
  }

  return { content };
}
