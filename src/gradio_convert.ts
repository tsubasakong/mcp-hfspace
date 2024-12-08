import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ApiEndpoint, ApiParameter } from "./gradio_api.js";

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

export function isFileParameter(param: ApiParameter): boolean {
  return (
    param.python_type?.type === "filepath" ||
    param.type === "Blob | File | Buffer" ||
    param.component === "Image" ||
    param.component === "Audio"
  );
}

export function convertParameter(param: ApiParameter): ParameterSchema {
  // Handle file types first
  if (param.python_type?.type === "filepath") {
    let fileDescription = "Accepts: URL, file path, or resource identifier";
    
    if (param.component === "Audio") {
      fileDescription = "Accepts: Audio file URL, file path, or resource identifier";
    } else if (param.component === "Image") {
      fileDescription = "Accepts: Image file URL, file path, or resource identifier";
    }

    return {
      type: "string",
      description: fileDescription,
      ...(param.example_input && {
        examples: [param.example_input.url || param.example_input.path]
      }),
    };
  }

  // Handle Blob | File | Buffer type
  if (param.type === "Blob | File | Buffer") {
    return {
      type: "string",
      description: "Accepts: URL, file path, or resource identifier",
      examples: [param.example_input?.url || param.example_input?.path].filter(Boolean),
    };
  }

  const baseSchema = {
    type: param.type || "string", // Default to string type if empty
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


export function convertApiToSchema(endpoint: ApiEndpoint) {
  const properties: { [key: string]: any } = {};
  const required: string[] = [];
  let propertyCounter = 1;
  const unnamedParameters: Record<string, number> = {};

  endpoint.parameters.forEach((param: ApiParameter, index: number) => {
    // Get property name from parameter_name, label, or generate one
    const propertyName = param.parameter_name || param.label || `Unnamed Parameter ${propertyCounter++}`;
    if (!param.parameter_name) {
      unnamedParameters[propertyName] = index;
    }
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

