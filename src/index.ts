#!/usr/bin/env node

/**
 * This is a template MCP server that implements a simple notes system.
 * It demonstrates core MCP concepts like resources and tools by allowing:
 * - Listing notes as resources
 * - Reading individual notes
 * - Creating new notes via a tool
 * - Summarizing all notes via a prompt
 */

import { Client } from "@gradio/client";

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
  "model_chat",
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
gradio = await Client.connect(hf_space);
const api = await gradio.view_api();

// Find the first matching endpoint from preferred list, or first available
const endpoint =
  chosen_api && api.named_endpoints[chosen_api]
    ? chosen_api
    : preferred_apis.find((api_name) => api.named_endpoints[api_name]) ||
      Object.keys(api.named_endpoints)[0];

// Get the parameters for the selected endpoint
const parameters = api.named_endpoints[endpoint].parameters;
console.log(endpoint);
console.log(hf_space);
console.log(convertToJsonSchema(parameters));
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
  const inputSchema = convertToJsonSchema(
    api.named_endpoints[endpoint].parameters
  );
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

  //throw new Error(JSON.stringify(request.params._meta));


  const progressToken = request.params._meta?.progressToken;
  const endpoint = `/${request.params.name}`;
  const parameters = request.params.arguments as Record<string, any>;

  try {
    const submission = gradio.submit(endpoint, parameters);
    let result: any;
    
    for await (const msg of submission) {
      if (msg.type === "data") {
        result = msg.data;
      } else if (msg.type === "status") {
        if (msg.stage === "error") {
          throw new Error(`Gradio error: ${msg.message || "Unknown error"}`);
        }
      }
    }

    if (!result) {
      throw new Error("No data received from endpoint");
    }

    return {
      content: [
        {
          type: "text",
          text: `Called endpoint ${endpoint} with result: ${JSON.stringify(result)}`,
        },
      ],
    } as typeof CallToolResultSchema._type;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to call endpoint ${endpoint}: ${errorMessage}`);
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

function convertToJsonSchema(parameters: any[]) {
  function pythonTypeToJsonType(pythonType: string): {
    type: string;
    format?: string;
  } {
    const cleanType = pythonType
      .replace(/\s/g, "")
      .replace(/List\[(.*)\]/, "$1");

    switch (cleanType.toLowerCase()) {
      case "str":
        return { type: "string" };
      case "int":
        return { type: "integer" };
      case "float":
        return { type: "number" };
      case "bool":
        return { type: "boolean" };
      case "dict":
        return { type: "object" };
      case "datetime":
        return { type: "string", format: "date-time" };
      case "date":
        return { type: "string", format: "date" };
      default:
        return { type: "string" };
    }
  }

  const schema: {
    type: "object";
    required?: string[];
    properties: Record<string, any>;
  } = {
    type: "object",
    required: [],
    properties: {},
  };

  parameters.forEach((param) => {
    const property: any = {
      title: param.label || "",
      description: param.python_type?.description || "",
    };

    // Convert Python type to JSON Schema type
    const typeInfo = pythonTypeToJsonType(param.python_type?.type || "str");
    Object.assign(property, typeInfo);

    // Handle arrays
    if (param.python_type?.type?.startsWith("List[")) {
      property.type = "array";
      property.items = pythonTypeToJsonType(
        param.python_type.type.match(/List\[(.*)\]/)?.[1] || "string"
      );
    }

    // Add default value if it exists
    if (param.parameter_has_default) {
      property.default = param.parameter_default;
    } else {
      // If parameter_has_default is false, this parameter is required
      schema.required = schema.required || [];
      schema.required.push(param.parameter_name);
    }

    // Add example if it exists
    if (param.example_input !== undefined) {
      property.examples = [param.example_input];
    }

    // Add component type as a format hint
    if (param.component) {
      property["x-component"] = param.component;
    }

    schema.properties[param.parameter_name] = property;
  });

  // Only include required array if there are required fields
  if (schema.required && schema.required.length === 0) {
    delete schema.required;
  }

  return schema;
}
