
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Status } from "@gradio/client";
import { ProgressNotification } from "@modelcontextprotocol/sdk/types.js";
import { ApiEndpoint } from "./ApiStructure.js";

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

export function convertApiToSchema(endpoint: ApiEndpoint) {
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

    if (param.description) {
      property.description = param.description;
    }

    if (param.type === "number" && param.python_type?.description) {
      Object.assign(property, parseNumericConstraints(param.python_type.description));
    }

    if (param.parameter_has_default) {
      property.default = param.parameter_default;
    } else {
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