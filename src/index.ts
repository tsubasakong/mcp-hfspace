#!/usr/bin/env node

/**
 * This is a template MCP server that implements a simple notes system.
 * It demonstrates core MCP concepts like resources and tools by allowing:
 * - Listing notes as resources
 * - Reading individual notes
 * - Creating new notes via a tool
 * - Summarizing all notes via a prompt
 */

import { Client, Status } from "@gradio/client";
import type { Payload } from "@gradio/client";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ProgressNotification,
  TextContent,
  ImageContent,
  CallToolResult,
  EmbeddedResource,
} from "@modelcontextprotocol/sdk/types.js";

// Just the types we need for the API structure - copied from Gradio client library
interface ApiParameter {
  label: string;
  parameter_name: string;
  parameter_has_default: boolean;
  parameter_default: any;
  type: string;
  python_type: {
    type: string;
    description: string;
  };
  component: string;
  example_input?: any;
}

interface ApiEndpoint {
  parameters: ApiParameter[];
  returns: {
    label: string;
    type: string;
    python_type: {
      type: string;
      description: string;
    };
    component: string;
  }[];
  type: {
    generator: boolean;
    cancel: boolean;
  };
}

interface ApiStructure {
  named_endpoints: Record<string, ApiEndpoint>;
  unnamed_endpoints: Record<string, ApiEndpoint>;
}

const preferred_apis = [
  "/predict",
  "/infer",
  "/generate",
  "/generate_image",
  "/complete",
  "/on_submit",
  "/model_chat",
];
let chosen_api = "";
let gradio;

// Get the HuggingFace space name from command line arguments
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("Error: HuggingFace space name is required as first argument");
  process.exit(1);
}

const hf_space = args[0];
gradio = await Client.connect(hf_space, { events: ["data", "status"] });
const api = (await gradio.view_api()) as ApiStructure;
// Find the first matching endpoint from preferred list, or first available
const endpoint =
  chosen_api && api.named_endpoints[chosen_api]
    ? chosen_api
    : preferred_apis.find((api_name) => api.named_endpoints[api_name]) ||
      Object.keys(api.named_endpoints)[0];

// Get the parameters for the selected endpoint
const parameters = api.named_endpoints[endpoint].parameters;

/*
 * Create an MCP server with capabilities for resources (to list/read notes),
 * tools (to create new notes), and prompts (to summarize notes).
 */
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

/**
 * Handler that lists available tools.
 * Exposes a single "create_note" tool that lets clients create new notes.
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const inputSchema = convertApiToSchema(api.named_endpoints[endpoint]);
  return {
    tools: [
      {
        name: endpoint.startsWith("/") ? endpoint.slice(1) : endpoint,
        description: `Call the ${hf_space} endpoint ${endpoint}`,
        inputSchema: inputSchema,
      },
    ],
  };
});

/**
 * Handler for the create_note tool.
 * Creates a new note with the provided title and content, and returns success message.
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const progressToken = request.params._meta?.progressToken;
  const endpoint = `/${request.params.name}`;
  const parameters = request.params.arguments as Record<string, any>;

  let lastProgress = 0;

  function createProgressNotification(
    status: Status,
    progressToken: string | number
  ): ProgressNotification {
    let progress = lastProgress;
    const total = 100;

    // Calculate progress based on different status conditions
    if (status.progress_data?.length) {
      const item = status.progress_data[0];
      if (
        item &&
        typeof item.index === "number" &&
        typeof item.length === "number"
      ) {
        // Scale progress from 10-90% during steps
        const stepProgress = (item.index / (item.length - 1)) * 80;
        progress = Math.round(10 + stepProgress); // Start at 10%, end at 90%
      }
    } else {
      // Stage-based progress estimation as fallback
      switch (status.stage) {
        case "pending":
          if (status.queue) {
            progress = status.position === 0 ? 10 : 5;
          } else {
            progress = 15;
          }
          break;
        case "generating":
          progress = 50;
          break;
        case "complete":
          progress = 100;
          break;
        case "error":
          progress = lastProgress;
          break;
      }
    }

    // Ensure progress always increases and doesn't get stuck
    progress = Math.max(progress, lastProgress);
    if (status.stage === "complete") {
      progress = 100;
    } else if (progress === lastProgress && lastProgress >= 75) {
      // If we're stuck at high progress, increment slightly
      progress = Math.min(99, lastProgress + 1);
    }

    lastProgress = progress;

    // Generate status message
    let message = status.message;
    if (!message) {
      if (status.queue && status.position !== undefined) {
        message = `Queued at position ${status.position}`;
      } else if (status.progress_data?.length) {
        const item = status.progress_data[0];
        message = item.desc || `Step ${item.index + 1} of ${item.length}`;
      } else {
        message = status.stage.charAt(0).toUpperCase() + status.stage.slice(1);
      }
    }

    const notification: ProgressNotification = {
      method: "notifications/progress",
      params: {
        progressToken,
        progress,
        total,
        message,
        _meta: {
          gradioStatus: {
            stage: status.stage,
            queue: status.queue,
            position: status.position,
            eta: status.eta,
            time: status.time,
            code: status.code,
            success: status.success,
            size: status.size,
            progress_data: status.progress_data,
          },
        },
      },
    };

    return notification;
  }

  try {
    let result: any;
    const submission = gradio.submit(endpoint, parameters);

    for await (const msg of submission) {
      if (msg.type === "data") {
        result = msg.data;
      } else if (msg.type === "status" && progressToken) {
        if (msg.stage === "error") {
          throw new Error(`Gradio error: ${msg.message || "Unknown error"}`);
        }
        const notification = createProgressNotification(msg, progressToken);
        await server.notification(notification);
      }
    }

    if (!result) {
      throw new Error("No data received from endpoint");
    }

    return await createToolResult(api.named_endpoints[endpoint].returns, {
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
function parseNumericConstraints(description: string) {
  const match = description.match(/numeric value between (\d+) and (\d+)/);
  if (match) {
    return {
      minimum: parseInt(match[1]),
      maximum: parseInt(match[2]),
    };
  }
  return {};
}

function convertApiToSchema(endpoint: ApiEndpoint) {
  // Type mapping from API to JSON Schema
  const typeMapping: { [key: string]: string } = {
    string: "string",
    number: "integer",
    boolean: "boolean",
  };

  const properties: { [key: string]: any } = {};
  const required: string[] = [];

  endpoint.parameters.forEach((param: any) => {
    const property: any = {
      type: typeMapping[param.type] || param.type,
    };

    // Add description if available
    if (param.description) {
      property.description = param.description;
    }

    // Add numeric constraints if available
    if (param.type === "number" && param.python_type?.description) {
      Object.assign(
        property,
        parseNumericConstraints(param.python_type.description)
      );
    }

    // Add default value if available
    if (param.parameter_has_default) {
      property.default = param.parameter_default;
    } else {
      // If no default, it's required
      required.push(param.parameter_name);
    }

    properties[param.parameter_name] = property;
  });

  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

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
