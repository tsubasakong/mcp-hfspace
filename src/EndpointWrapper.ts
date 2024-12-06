import { Client } from "@gradio/client";
import { ApiStructure, ApiEndpoint } from "./ApiStructure.js";
import { convertApiToSchema } from "./utils.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import * as fs from "fs/promises";
import * as ps from "process";
import type {
  CallToolResult,
  GetPromptResult,
  PromptArgument,
  PromptMessage,
} from "@modelcontextprotocol/sdk/types.d.ts";
import type {
  TextContent,
  ImageContent,
  EmbeddedResource,
} from "@modelcontextprotocol/sdk/types.d.ts";
import { createProgressNotifier } from "./utils.js";

type GradioComponent = {
  label: string;
  type: string;
  python_type: {
    type: string;
    description: string;
  };
  component: string;
};

// Simple converter registry
type ContentConverter = (
  component: GradioComponent,
  value: any
) => Promise<TextContent | ImageContent | EmbeddedResource>;

// Type for converter functions that may not succeed
type ConverterFn = (
  component: GradioComponent,
  value: any
) => Promise<TextContent | ImageContent | EmbeddedResource | null>;
// Default converter implementation
const defaultConverter: ConverterFn = async () => null;

class GradioConverter {
  private static converters: Map<string, ContentConverter> = new Map();

  static register(component: string, converter: ContentConverter) {
    this.converters.set(component, converter);
  }

  static async convert(
    component: GradioComponent,
    value: any
  ): Promise<TextContent | ImageContent | EmbeddedResource> {
    const converter =
      this.converters.get(component.component) ||
      withFallback(defaultConverter);
    return converter(component, value);
  }
}

// Shared text content creator
const createTextContent = (
  component: GradioComponent,
  value: any
): TextContent => {
  const label = component.label ? `${component.label}: ` : "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return {
    type: "text",
    text: `${label}${text}`,
  };
};

// Wrapper that adds fallback behavior
const withFallback = (converter: ConverterFn): ContentConverter => {
  return async (component: GradioComponent, value: any) => {
    const result = await converter(component, value);
    return result ?? createTextContent(component, value);
  };
};

// Converter implementations focus only on their specific cases
const convertUrlToBase64 = async (url: string, defaultMimeType: string) => {
  const response = await fetch(url);
  const mimeType = response.headers.get("content-type") || defaultMimeType;
  const arrayBuffer = await response.arrayBuffer();
  const base64Data = Buffer.from(arrayBuffer).toString("base64");
  return { mimeType, base64Data, arrayBuffer };
};

const imageConverter: ConverterFn = async (component, value) => {
  console.error(JSON.stringify(value,null,2));
  if (!value?.url) return null;
  const { mimeType, base64Data } = await convertUrlToBase64(
    value.url,
    "image/png"
  );
  return {
    type: "image",
    data: base64Data,
    mimeType,
  };
};

const audioConverter: ConverterFn = async (component, value) => {
  console.error(JSON.stringify(value,null,2));
  if (!value?.url) return null;
  const { mimeType, base64Data, arrayBuffer } = await convertUrlToBase64(
    value.url,
    "audio/wav"
  );
  const extension = mimeType.split("/")[1] || "wav";
  const filename = `downloaded_audio_${crypto.randomUUID()}.${extension}`;
  await fs.writeFile(filename, Buffer.from(arrayBuffer), {
    encoding: "binary",
  });
  console.error(`Saved audio to ${filename}`);

  return {
    type: "resource",
    resource: {
      uri: `data:${mimeType};base64,${base64Data}`,
      mimeType,
      blob: base64Data,
    },
  };
};

// Register converters with fallback behavior
GradioConverter.register("Image", withFallback(imageConverter));
GradioConverter.register("Audio", withFallback(audioConverter));
GradioConverter.register(
  "Chatbot",
  withFallback(async () => null)
);

export class EndpointWrapper {
  private anonIndex: number;

  constructor(
    private endpointName: string,
    private endpoint: ApiEndpoint,
    private spaceName: string,
    private client: Client,
    anonIndex = -1
  ) {
    this.spaceName = spaceName;
    this.anonIndex = anonIndex;
  }

  static async createEndpoint(spacePath: string): Promise<EndpointWrapper> {
    const pathParts = spacePath.split("/");

    if (pathParts.length < 2 || pathParts.length > 3) {
      throw new Error(
        `Invalid space path format [${spacePath}]. Use: vendor/space or vendor/space/endpoint`
      );
    }

    const spaceName = `${pathParts[0]}/${pathParts[1]}`;
    const endpointName = pathParts[2];

    const preferredApis = [
      "/predict",
      "/infer",
      "/generate",
      "/generate_image",
      "/process_prompt",
      "/complete",
      "/lambda",
      "/on_submit",
      "/model_chat",
    ];

    const gradio = await Client.connect(spaceName, {
      events: ["data", "status"],
      hf_token: process.env.HF_TOKEN,
    });
    const api = (await gradio.view_api()) as ApiStructure;

    // Try chosen API if specified
    if (endpointName && api.named_endpoints[endpointName]) {
      return new EndpointWrapper(
        endpointName,
        api.named_endpoints[endpointName],
        spaceName,
        gradio
      );
    }

    // Try preferred APIs
    const preferredApi = preferredApis.find(
      (name) => api.named_endpoints[name]
    );
    if (preferredApi) {
      return new EndpointWrapper(
        preferredApi,
        api.named_endpoints[preferredApi],
        spaceName,
        gradio
      );
    }

    // Try first named endpoint
    const firstNamed = Object.entries(api.named_endpoints)[0];
    if (firstNamed) {
      return new EndpointWrapper(
        firstNamed[0],
        firstNamed[1],
        spaceName,
        gradio
      );
    }

    // Try unnamed endpoints
    const validUnnamed = Object.entries(api.unnamed_endpoints).find(
      ([_, endpoint]) =>
        endpoint.parameters.length > 0 && endpoint.returns.length > 0
    );

    if (validUnnamed) {
      return new EndpointWrapper(
        spaceName.split("/")[1],
        validUnnamed[1],
        spaceName,
        gradio,
        parseInt(validUnnamed[0])
      );
    }

    throw new Error(`No valid endpoints found for ${spacePath}`);
  }

  /* Endpoint Wrapper */

  get toolName() {
    const name = `${this.spaceName.split("/")[1]}-${
      this.anonIndex < 0 ? this.endpointName.slice(1) : this.endpointName
    }`
      .replace(/[^a-zA-Z0-9_-]/g, "_") // Replace invalid chars with underscore
      .slice(0, 64); // Limit length to 64 chars
    return name || "unnamed_tool"; // Fallback if empty
  }

  toolDefinition() {
    return {
      name: this.toolName,
      description: `Call the ${this.spaceName} endpoint ${this.endpointName}`,
      inputSchema: convertApiToSchema(this.endpoint),
    };
  }

  async handleToolCall(
    parameters: Record<string, any>,
    progressToken: string | undefined,
    server: Server
  ): Promise<CallToolResult> {
    try {
      let result: any;
      const submission = this.client.submit(
        this.anonIndex < 0 ? this.endpointName : this.anonIndex,
        parameters
      );

      const progressNotifier = createProgressNotifier(server);

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

      return await this.convertPredictResults(this.endpoint.returns, result);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Error calling endpoint: ${errorMessage}`);
    }
  }

  private async convertPredictResults(
    returns: GradioComponent[],
    predictResults: any[]
  ): Promise<CallToolResult> {
    const content: (TextContent | ImageContent | EmbeddedResource)[] = [];

    for (const [index, output] of returns.entries()) {
      const value = predictResults[index];
      const converted = await GradioConverter.convert(output, value);
      content.push(converted);
    }

    return {
      content,
      isError: false,
    };
  }

  promptName() {
    // Keep consistent with toolName pattern
    return this.toolName;
  }

  promptDefinition() {
    return {
      name: `${this.promptName()} -- My working dir is ${ps.cwd()}`,
      description: `Use the ${this.spaceName} endpoint ${this.endpointName}.`,
      arguments: this.convertToPromptArguments(this.endpoint.parameters),
    };
  }

  private convertToPromptArguments(
    parameters: GradioComponent[]
  ): PromptArgument[] {
    return parameters.map((param) => ({
      name: param.label || param.component,
      description: this.getParameterDescription(param),
      required: true, // Could be enhanced with actual required status if available from Gradio
    }));
  }

  private getParameterDescription(param: GradioComponent): string {
    const type = param.python_type?.description || param.component;
    const baseDesc = `${type} input`;

    // Add component-specific details
    switch (param.component) {
      case "Image":
        return `${baseDesc} - Provide an image description or URL`;
      case "Audio":
        return `${baseDesc} - Provide audio file URL or description`;
      case "Slider":
        return `${baseDesc} - Provide a numeric value`;
      default:
        return baseDesc;
    }
  }

  async getPromptTemplate(
    args?: Record<string, string>
  ): Promise<GetPromptResult> {
    const messages: PromptMessage[] = [
      {
        role: "user",
        content: {
          type: "text",
          text: this.generatePromptText(args),
        },
      },
    ];

    return {
      description: this.promptDefinition().description,
      messages,
    };
  }

  private generatePromptText(args?: Record<string, string>): string {
    const params = this.endpoint.parameters;
    let text = `Using the ${this.spaceName} ${this.endpointName} endpoint:\n\n`;

    if (args) {
      // Include provided arguments
      text += params
        .map((param) => {
          const value = args[param.label] || "[not provided]";
          return `${param.label}: ${value}`;
        })
        .join("\n");
    } else {
      // Show parameter template
      text += params
        .map((param) => {
          return `${param.label}: [Provide ${param.component} input]`;
        })
        .join("\n");
    }

    return text;
  }
}
