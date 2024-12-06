import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Status } from "@gradio/client";
import type { ProgressNotification, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ApiEndpoint, ApiParameter } from "../src/ApiStructure.js";

// Type for a parameter schema in MCP Tool
type ParameterSchema = Tool["inputSchema"]["properties"];

function parseNumberConstraints(description: string = "") {
  const constraints: { minimum?: number; maximum?: number } = {};
  
  // Check for "between X and Y" format
  const betweenMatch = description.match(/between\s+(-?\d+\.?\d*)\s+and\s+(-?\d+\.?\d*)/i);
  if (betweenMatch) {
    constraints.minimum = Number(betweenMatch[1]);
    constraints.maximum = Number(betweenMatch[2]);
    return constraints;
  }
  
  // Fall back to existing min/max parsing
  const minMatch = description.match(/min(?:imum)?\s*[:=]\s*(-?\d+\.?\d*)/i);
  const maxMatch = description.match(/max(?:imum)?\s*[:=]\s*(-?\d+\.?\d*)/i);
  
  if (minMatch) constraints.minimum = Number(minMatch[1]);
  if (maxMatch) constraints.maximum = Number(maxMatch[1]);
  return constraints;
}

export function convertParameter(param: ApiParameter): ParameterSchema {
  const baseSchema = {
    type: param.type,
    description: param.python_type?.description || param.label || undefined,
    ...(param.parameter_has_default && {
      default: param.parameter_default,
    }),
    ...(param.example_input && {
      examples: [param.example_input],
    }),
  };

  // Add number constraints if it's a number type 
  if (param.type === "number" && param.python_type?.description) {
    const constraints = parseNumberConstraints(param.python_type.description);
    return { ...baseSchema, ...constraints };
  }

  // Handle Literal type to extract enum values
  if (param.python_type?.type?.startsWith("Literal[")) {
    const enumValues = param.python_type.type
      .slice(8, -1) // Remove "Literal[" and "]"
      .split(",")
      .map(value => value.trim().replace(/['"]/g, "")); // Remove quotes and trim spaces
    return { ...baseSchema, description: param.python_type?.description || param.label || undefined, enum: enumValues };
  }

  return baseSchema;
}


export interface ProgressNotifier {
  notify(status: Status, progressToken: string | number): Promise<void>;
}

export function createProgressNotifier(server: Server): ProgressNotifier {
  
  let lastProgress = 0;

  function createNotification(
    status: Status,
    progressToken: string | number
  ): ProgressNotification {
    
    let progress = lastProgress;
    const total = 100;

    if (status.progress_data?.length) {
      const item = status.progress_data[0];
      if (item && typeof item.index === "number" && typeof item.length === "number") {
        const stepProgress = (item.index / (item.length - 1)) * 80;
        progress = Math.round(10 + stepProgress);
      }
    } else {
      switch (status.stage) {
        case "pending":
          progress = status.queue ? (status.position === 0 ? 10 : 5) : 15;
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

    progress = Math.max(progress, lastProgress);
    if (status.stage === "complete") {
      progress = 100;
    } else if (progress === lastProgress && lastProgress >= 75) {
      progress = Math.min(99, lastProgress + 1);
    }

    lastProgress = progress;

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

    return {
      method: "notifications/progress",
      params: {
        progressToken,
        progress,
        total,
        message,
        _meta: status
      },
    };
  }

  return {
    async notify(status: Status, progressToken: string | number) {
      if (!progressToken) return;
      const notification = createNotification(status, progressToken);
      await server.notification(notification);
    }
  };
}

export function convertApiToSchema(endpoint: ApiEndpoint) {
  const properties: { [key: string]: any } = {};
  const required: string[] = [];
  let propertyCounter = 1;

  endpoint.parameters.forEach((param: any) => {
    // Get property name from parameter_name, label, or generate one
    const propertyName = param.parameter_name || param.label || `Property ${propertyCounter++}`;
    
    // Convert parameter using existing function
    properties[propertyName] = convertParameter(param);

    // Add to required if no default value
    if (!param.parameter_has_default) {
      required.push(propertyName);
    }
  });

  return {
    type: "object",
    properties,
    required,
  };
}