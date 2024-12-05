import { Client } from "@gradio/client";
import { ApiStructure, ApiEndpoint } from "./ApiStructure.js";
import { convertApiToSchema } from "./utils.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Payload } from "@gradio/client";
import { TextContent, ImageContent, EmbeddedResource } from "@modelcontextprotocol/sdk/types.js";
import { createProgressNotifier } from "./utils.js";

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

  static async createEndpoint(spacePath: string): Promise<EndpointWrapper | null> {
    const pathParts = spacePath.split('/');

    if (pathParts.length < 2 || pathParts.length > 3) {
      throw new Error("Invalid space path format. Use: vendor/space or vendor/space/endpoint");
    }

    const spaceName = `${pathParts[0]}/${pathParts[1]}`;
    const endpointName = pathParts[2];

    const preferredApis = [
      "/predict",
      "/infer",
      "/generate",
      "/generate_image",
      "/complete",
      "/lambda",
      "/on_submit",
      "/model_chat",
    ];    


    const gradio = await Client.connect(spaceName, { events: ["data", "status"], hf_token: process.env.HF_TOKEN});
    const api = await gradio.view_api() as ApiStructure;

    // Try chosen API if specified
    if (endpointName && api.named_endpoints[endpointName]) {
      return new EndpointWrapper(endpointName, api.named_endpoints[endpointName], spaceName, gradio);
    }

    // Try preferred APIs
    const preferredApi = preferredApis.find(name => api.named_endpoints[name]);
    if (preferredApi) {
      return new EndpointWrapper(preferredApi, api.named_endpoints[preferredApi], spaceName, gradio);
    }

    // Try first named endpoint
    const firstNamed = Object.entries(api.named_endpoints)[0];
    if (firstNamed) {
      return new EndpointWrapper(firstNamed[0], firstNamed[1], spaceName, gradio);
    }

    // Try unnamed endpoints
    const validUnnamed = Object.entries(api.unnamed_endpoints)
      .find(([_, endpoint]) => endpoint.parameters.length > 0 && endpoint.returns.length > 0);
    
    if (validUnnamed) {
      return new EndpointWrapper(spaceName.split("/")[1], validUnnamed[1], spaceName, gradio);
    }

    throw new Error("No valid endpoints found in the API");
  }

/* Endpoint Wrapper */

  get toolName() {
    const name = `${this.spaceName.split("/")[1]}-${this.endpointName.slice(1)}`
      .replace(/[^a-zA-Z0-9_-]/g, '_')  // Replace invalid chars with underscore
      .slice(0, 64);                     // Limit length to 64 chars
    return name || 'unnamed_tool';        // Fallback if empty
  }

  get parameters() {
    return this.endpoint.parameters;
  }

  get returns() {
    return this.endpoint.returns;
  }

  get call_path() {
    return this.endpointName;
  }

  toolDefinition() {
    return {
      name: this.toolName,
      description: `Call the ${this.spaceName} endpoint ${this.endpointName}`,
      inputSchema: convertApiToSchema(this.endpoint),
    };
  }

  async handleToolCall(parameters: Record<string, any>, progressToken: string| undefined, server: Server): Promise<CallToolResult> {
    try {
        let result: any;
        const submission = this.client.submit(this.anonIndex < 0 ? this.endpointName : this.anonIndex, parameters);
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

        return await this.createToolResult(result);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Error calling endpoint: ${errorMessage}`);
    }
  }

  private async createToolResult(predictResults: Payload): Promise<CallToolResult> {
    const content: Array<TextContent | ImageContent | EmbeddedResource> = [];

    for (const [index, output] of this.returns.entries()) {
        const value = predictResults[index];

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
                        const mimeType = response.headers.get("content-type") || "image/png";
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
                    if (value !== null && value !== undefined) {
                        content.push({
                            type: "text",
                            text: `${output.label}: ${value}`,
                        });
                    }
                    break;
            }
        } catch (error) {
            content.push({
                type: "text",
                text: `Error converting ${output.label}: ${(error as Error).message}`,
            });
        }
    }

    return { content };
  }
}