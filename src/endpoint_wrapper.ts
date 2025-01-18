import { Client, handle_file } from "@gradio/client";
import { ApiStructure, ApiEndpoint, ApiReturn } from "./gradio_api.js";
import { convertApiToSchema, isFileParameter } from "./gradio_convert.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import * as fs from "fs/promises";
import { ReadableStream, TransformStream } from "node:stream/web";
import * as path from "path";
import type { StatusMessage, Payload } from "@gradio/client";
import type {
  CallToolResult,
  GetPromptResult,
  CallToolRequest,
} from "@modelcontextprotocol/sdk/types.d.ts";
import type {
  TextContent,
  ImageContent,
  EmbeddedResource,
} from "@modelcontextprotocol/sdk/types.d.ts";
import { config } from "./config.js";
import { WorkingDirectory } from "./working_directory.js";
import { createProgressNotifier } from "./progress_notifier.js";
import { GradioConverter } from "./content_converter.js";

type GradioEvent = StatusMessage | Payload;

interface SpaceRuntimeStatus {
  stage: string;
  sdk?: string;
  hardware?: string;
  resources?: Record<string, unknown>;
  // Add other fields as needed
}

export interface EndpointPath {
  owner: string;
  space: string;
  endpoint: string | number;
  mcpToolName: string;
  mcpDisplayName: string;
}

// Helper function to parse "owner/space/endpoint"
export function parsePath(path: string): EndpointPath {
  const parts = path.replace(/^\//, "").split("/");

  if (parts.length !== 3) {
    throw new Error(
      `Invalid Endpoint path format [${path}]. Use or vendor/space/endpoint`
    );
  }

  const [owner, space, rawEndpoint] = parts;
  return {
    owner,
    space,
    endpoint: isNaN(Number(rawEndpoint))
      ? `/${rawEndpoint}`
      : parseInt(rawEndpoint),
    mcpToolName: formatMcpToolName(space, rawEndpoint),
    mcpDisplayName: formatMcpDisplayName(space, rawEndpoint),
  };

  function formatMcpToolName(space: string, endpoint: string | number) {
    return `${space}-${endpoint}`
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 64);
  }

  function formatMcpDisplayName(space: string, endpoint: string | number) {
    return `${space} endpoint /${endpoint}`;
  }
}

export class EndpointWrapper {
  private converter: GradioConverter;

  constructor(
    private endpointPath: EndpointPath,
    private endpoint: ApiEndpoint,
    private client: Client,
    private workingDir: WorkingDirectory
  ) {
    this.converter = new GradioConverter(workingDir);
  }

  // Create a new EndpointWrapper by connecting to the space’s Gradio app
  static async createEndpoint(
    configuredPath: string,
    workingDir: WorkingDirectory
  ): Promise<EndpointWrapper> {
    const pathParts = configuredPath.split("/");
    if (pathParts.length < 2 || pathParts.length > 3) {
      throw new Error(
        `Invalid space path format [${configuredPath}]. Use: vendor/space or vendor/space/endpoint`
      );
    }

    const spaceName = `${pathParts[0]}/${pathParts[1]}`;
    const endpointTarget = pathParts[2] ? `/${pathParts[2]}` : undefined;

    try {
      // 1) Check space metadata
      if (config.debug) {
        console.error(`[DEBUG] Checking space metadata for ${spaceName}...`);
      }
      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      if (config.hfToken) {
        headers["Authorization"] = `Bearer ${config.hfToken}`;
      }

      const metadataRes = await fetch(
        `https://huggingface.co/api/spaces/${spaceName}`,
        { headers }
      );
      if (!metadataRes.ok) {
        if (config.debug) {
          console.error(
            `[DEBUG] Metadata check failed:`,
            metadataRes.status,
            metadataRes.statusText
          );
          const text = await metadataRes.text();
          console.error(`[DEBUG] Response body:`, text);
        }
        throw new Error(
          `Space ${spaceName} is not accessible (HTTP ${metadataRes.status})`
        );
      }

      if (config.debug) {
        console.error(`[DEBUG] Connecting to Gradio client for ${spaceName}...`);
      }

      // 2) Connect to Gradio client
      // We do NOT pass in a custom fetch or streams. We rely on Node’s built-in fetch & streams in Node 18+
      const gradioClient = await Client.connect(spaceName, {
        hf_token: config.hfToken,
        max_retries: 5,
        timeout: 600_000,
        verbose: config.debug,
      });

      // 3) Retrieve Gradio API structure
      const api = (await gradioClient.view_api()) as ApiStructure;
      if (!api || (!api.named_endpoints && !api.unnamed_endpoints)) {
        throw new Error(`No endpoints found in space ${spaceName}`);
      }

      // 4) Select the endpoint
      if (endpointTarget && api.named_endpoints[endpointTarget]) {
        return new EndpointWrapper(
          parsePath(configuredPath),
          api.named_endpoints[endpointTarget],
          gradioClient,
          workingDir
        );
      }

      // Check some common endpoint names
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
        "/add_text",
      ];
      const namedMatch = preferredApis.find((p) => api.named_endpoints[p]);
      if (namedMatch) {
        return new EndpointWrapper(
          parsePath(`${configuredPath}${namedMatch}`),
          api.named_endpoints[namedMatch],
          gradioClient,
          workingDir
        );
      }

      // If no named endpoints matched, pick the first named or first valid unnamed
      const [firstNamedKey, firstNamedVal] =
        Object.entries(api.named_endpoints)[0] ?? [];
      if (firstNamedKey && firstNamedVal) {
        return new EndpointWrapper(
          parsePath(`${configuredPath}${firstNamedKey}`),
          firstNamedVal,
          gradioClient,
          workingDir
        );
      }

      const [validUnnamedKey, validUnnamedVal] =
        Object.entries(api.unnamed_endpoints).find(
          ([_, ep]) => ep.parameters.length > 0 && ep.returns.length > 0
        ) ?? [];
      if (validUnnamedKey && validUnnamedVal) {
        return new EndpointWrapper(
          parsePath(`${configuredPath}/${validUnnamedKey}`),
          validUnnamedVal,
          gradioClient,
          workingDir
        );
      }

      throw new Error(`No valid endpoints found for ${configuredPath}`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      if (config.debug) {
        console.error(`[DEBUG] Error connecting to space ${spaceName}:`, error);
      }
      throw new Error(
        `Failed to connect to space ${spaceName}: ${errMsg}\n` +
          `Make sure:\n` +
          `1. The space exists and is public (check https://huggingface.co/spaces/${spaceName})\n` +
          `2. Your HF_TOKEN is valid (if the space is private)\n` +
          `3. The space is running (not sleeping or failed)\n` +
          `4. The space has a valid Gradio API endpoint\n` +
          `5. You have permission to access the space\n\n` +
          `Try visiting the space in your browser first to ensure it's running.`
      );
    }
  }

  /* Endpoint Wrapper methods remain the same */

  async validatePath(filePath: string): Promise<string> {
    return this.workingDir.validatePath(filePath);
  }

  promptName() {
    return this.endpointPath.mcpToolName;
  }

  private mcpDescriptionName(): string {
    return this.endpointPath.mcpDisplayName;
  }

  toolDefinition() {
    return {
      name: this.endpointPath.mcpToolName,
      description: `Call the ${this.mcpDescriptionName()}`,
      inputSchema: convertApiToSchema(this.endpoint),
    };
  }

  async call(request: CallToolRequest, server: Server): Promise<CallToolResult> {
    const progressToken = request.params._meta?.progressToken as
      | string
      | number
      | undefined;

    const parameters = request.params.arguments as Record<string, any>;
    const endpointParams = this.endpoint.parameters;

    // Convert file paths to file handles
    for (const [key, value] of Object.entries(parameters)) {
      const param = endpointParams.find(
        (p) => p.parameter_name === key || p.label === key
      );
      if (param && isFileParameter(param) && typeof value === "string") {
        const file = await this.validatePath(value);
        parameters[key] = handle_file(file);
      }
    }

    const normalizedToken =
      typeof progressToken === "number" ? progressToken.toString() : progressToken;

    return this.handleToolCall(parameters, normalizedToken, server);
  }

  async handleToolCall(
    parameters: Record<string, unknown>,
    progressToken: string | undefined,
    server: Server
  ): Promise<CallToolResult> {
    const events: unknown[] = [];
    try {
      let result = null;
      const submission = this.client.submit(
        this.endpointPath.endpoint,
        parameters
      ) as AsyncIterable<GradioEvent>;
      const progressNotifier = createProgressNotifier(server);

      for await (const msg of submission) {
        if (config.debug) events.push(msg);
        if (msg.type === "data") {
          if (Array.isArray(msg.data)) {
            // Check which item has non-object data
            const hasContent = msg.data.some(
              (item: unknown) => typeof item !== "object"
            );
            if (hasContent) result = msg.data;
            if (result === null) result = msg.data;
          }
        } else if (msg.type === "status") {
          if (msg.stage === "error") {
            throw new Error(`Gradio error: ${msg.message || "Unknown error"}`);
          }
          if (progressToken) await progressNotifier.notify(msg, progressToken);
        }
      }

      if (!result) {
        throw new Error("No data received from endpoint");
      }

      return await this.convertPredictResults(
        this.endpoint.returns,
        result,
        this.endpointPath
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new Error(`Error calling endpoint: ${errMsg}`);
    } finally {
      // Save debug info if we have any
      if (config.debug && events.length > 0) {
        const traceFile = `${this.endpointPath.mcpToolName}_status_${crypto
          .randomUUID()
          .substring(0, 5)}.json`;
        await fs.writeFile(traceFile, JSON.stringify(events, null, 2));
      }
    }
  }

  private async convertPredictResults(
    returns: ApiReturn[],
    predictResults: any[],
    endpointPath: EndpointPath
  ): Promise<CallToolResult> {
    const content: (TextContent | ImageContent | EmbeddedResource)[] = [];
    for (const [index, output] of returns.entries()) {
      const value = predictResults[index];
      const converted = await this.converter.convert(output, value, endpointPath);
      content.push(converted);
    }
    return { content, isError: false };
  }

  async getPromptTemplate(
    args?: Record<string, string>
  ): Promise<GetPromptResult> {
    const schema = convertApiToSchema(this.endpoint);
    let promptText = `Using the ${this.mcpDescriptionName()}:\n\n`;

    promptText += Object.entries(schema.properties)
      .map(([name, prop]) => {
        const defaultHint =
          prop.default !== undefined ? `- default: ${prop.default}` : "";
        const value =
          args?.[name] || `[Provide ${prop.description || name} ${defaultHint}]`;
        return `${name}: ${value}`;
      })
      .join("\n");

    return {
      description: `Use the ${this.mcpDescriptionName()}.`,
      messages: [
        {
          role: "user",
          content: { type: "text", text: promptText },
        },
      ],
    };
  }

  promptDefinition() {
    return {
      name: this.endpointPath.mcpToolName,
      description: `Use the ${this.mcpDescriptionName()}.`,
      arguments: Object.keys(convertApiToSchema(this.endpoint).properties),
    };
    }
}
