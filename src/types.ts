
/** represents a space + function to call */
import { ApiStructure, ApiEndpoint } from "./ApiStructure.js";
import { convertApiToSchema } from "./utils.js";




export class EndpointWrapper {
  constructor(
    private path: string,
    private endpoint: ApiEndpoint,
    private isNamed: boolean
  ) {}

  static findPreferred(api: ApiStructure, options: {
    chosenApi?: string;
  } = {}) {

    const preferredApis = [
      "/predict",
      "/infer",
      "/generate",
      "/generate_image",
      "/complete",
      "/on_submit",
      "/model_chat",
    ];    
    const { chosenApi } = options;

    // Try chosen API if specified
    if (chosenApi && api.named_endpoints[chosenApi]) {
      return new EndpointWrapper(chosenApi, api.named_endpoints[chosenApi], true);
    }

    // Try preferred APIs
    const preferredApi = preferredApis.find(name => api.named_endpoints[name]);
    if (preferredApi) {
      return new EndpointWrapper(preferredApi, api.named_endpoints[preferredApi], true);
    }

    // Try first named endpoint
    const firstNamed = Object.entries(api.named_endpoints)[0];
    if (firstNamed) {
      return new EndpointWrapper(firstNamed[0], firstNamed[1], true);
    }

    // Try unnamed endpoints
    const validUnnamed = Object.entries(api.unnamed_endpoints)
      .find(([_, endpoint]) => endpoint.parameters.length > 0 && endpoint.returns.length > 0);
    
    if (validUnnamed) {
      return new EndpointWrapper(validUnnamed[0], validUnnamed[1], false);
    }

    throw new Error("No valid endpoints found in the API");
  }

  get toolName() {
    return this.path.startsWith("/") ? this.path.slice(1) : this.path;
  }

  get parameters() {
    return this.endpoint.parameters;
  }

  get returns() {
    return this.endpoint.returns;
  }

  get call_path() {
    return this.path;
  }

  toToolDefinition(spaceName: string) {
    return {
      name: this.toolName,
      description: `Call the ${spaceName} endpoint ${this.path}`,
      inputSchema: convertApiToSchema(this.endpoint),
    };
  }
}