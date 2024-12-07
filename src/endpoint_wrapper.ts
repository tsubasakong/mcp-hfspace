import { Client } from "@gradio/client";
import { handle_file } from "@gradio/client";
import {
  ApiStructure,
  ApiEndpoint,
  ApiParameter,
  ApiReturn,
} from "./gradio_api.js";
import { convertApiToSchema, isFileParameter } from "./gradio_convert.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import * as fs from "fs/promises";
import * as ps from "process";
import type {
  CallToolResult,
  GetPromptResult,
  PromptArgument,
  PromptMessage,
  CallToolRequest,
} from "@modelcontextprotocol/sdk/types.d.ts";
import type {
  TextContent,
  ImageContent,
  EmbeddedResource,
} from "@modelcontextprotocol/sdk/types.d.ts";
import { createProgressNotifier } from "./progress_notifier.js";
import { GradioConverter } from "./content_converter.js";
import { config } from "./config.js";


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
      "/complete",
      "/model_chat",
      "/lambda",
      "/generate_image",
      "/process_prompt",
      "/on_submit",
    ];

    const gradio = await Client.connect(spaceName, {
      events: ["data", "status"],
      hf_token: config.hfToken,
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

  async call(request: CallToolRequest, server: Server): Promise<CallToolResult> {
    const progressToken = request.params._meta?.progressToken as
      | string
      | number
      | undefined;

    const parameters = request.params.arguments as Record<string, any>;
    
    // Get the endpoint parameters to check against
    const endpointParams = this.endpoint.parameters;
    
    // Process each parameter, applying handle_file for file inputs
    for (const [key, value] of Object.entries(parameters)) {
      const param = endpointParams.find(p => p.parameter_name === key || p.label === key);
      if (param && isFileParameter(param) && typeof value === "string") {
        parameters[key] = handle_file(value);
      }
    }

    const normalizedToken =
      typeof progressToken === "number"
        ? progressToken.toString()
        : progressToken;

    return this.handleToolCall(parameters, normalizedToken, server);
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
    returns: ApiReturn[],
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
    // Use the same name as the tool for consistency
    return this.toolName;
  }

  promptDefinition() {
    const schema = convertApiToSchema(this.endpoint);
    return {
      name: this.promptName(),
      description: `Use the ${this.spaceName} endpoint ${this.endpointName}.`,
      arguments: Object.entries(schema.properties).map(([name, prop]: [string, any]) => ({
        name,
        description: prop.description || name,
        required: schema.required?.includes(name) || false,
      })),
    };
  }

  async getPromptTemplate(
    args?: Record<string, string>
  ): Promise<GetPromptResult> {
    const schema = convertApiToSchema(this.endpoint);
    let promptText = `Using the ${this.spaceName} ${this.endpointName} endpoint:\n\n`;

    promptText += Object.entries(schema.properties)
      .map(([name, prop]: [string, any]) => {
        let defaultHint = prop.default !== undefined ? ` - default: ${prop.default}` : '';
        const value = args?.[name] || `[Provide ${prop.description || name}${defaultHint}]`;
        return `${name}: ${value}`;
      })
      .join('\n');

    return {
      description: this.promptDefinition().description,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: promptText,
          },
        },
      ],
    };
  }
}
