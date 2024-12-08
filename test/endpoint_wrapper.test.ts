
import { describe, it, expect, vi } from "vitest";
import { EndpointWrapper } from "../src/endpoint_wrapper";
import type { ApiEndpoint } from "../src/gradio_api";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

// Mock the Client class
const mockSubmit = vi.fn();
const MockClient = {
  submit: mockSubmit,
  connect: vi.fn().mockResolvedValue({
    submit: mockSubmit,
    view_api: vi.fn(),
  }),
};

// Helper to create test endpoint
function createTestEndpoint(parameters: any[]): ApiEndpoint {
  return {
    parameters,
    returns: [{
      label: "Output",
      type: "string",
      python_type: { type: "str", description: "Output text" },
      component: "Text"
    }],
    type: { generator: false, cancel: false }
  };
}

describe("EndpointWrapper parameter mapping", () => {
  it("maps named parameters correctly", async () => {
    const endpoint = createTestEndpoint([
      {
        label: "Text Input",
        parameter_name: "text_input",
        type: "string",
        python_type: { type: "str", description: "" },
        component: "Textbox"
      }
    ]);

    const wrapper = new EndpointWrapper(
      "predict",
      endpoint,
      "test/space",
      MockClient as any,
      -1
    );

    // Mock successful response
    mockSubmit.mockImplementation(async function* () {
      yield { type: "data", data: ["response"] };
    });

    await wrapper.call({
      method: "tools/call",
      params: {
        name: "test",
        arguments: {
          text_input: "hello"
        }
      }
    }, {} as Server);

    // Verify the parameters were mapped correctly
    expect(mockSubmit).toHaveBeenCalledWith("predict", {
      text_input: "hello"
    });
  });

  it("maps unnamed parameters to their index", async () => {
    const endpoint = createTestEndpoint([
      {
        label: "parameter_0",
        type: "string",
        python_type: { type: "str", description: "" },
        component: "Textbox"
      },
      {
        label: "parameter_1", 
        type: "number",
        python_type: { type: "float", description: "" },
        component: "Number"
      }
    ]);

    const wrapper = new EndpointWrapper(
      "predict",
      endpoint,
      "test/space",
      MockClient as any,
      -1
    );

    mockSubmit.mockImplementation(async function* () {
      yield { type: "data", data: ["response"] };
    });

    await wrapper.call({
      params: {
        name: "test",
        arguments: {
          "parameter_0": "hello",
          "parameter_1": 42
        }
      },
      method: "tools/call"
    }, {} as Server);

    // Verify parameters were mapped by position
    expect(mockSubmit).toHaveBeenCalledWith("predict", {
      "parameter_0": "hello",
      "parameter_1": 42
    });
  });

  it("handles mix of named and unnamed parameters", async () => {
    const endpoint = createTestEndpoint([
      {
        label: "Text Input",
        parameter_name: "text_input",
        type: "string",
        python_type: { type: "str", description: "" },
        component: "Textbox"
      },
      {
        label: "parameter_1",
        type: "number", 
        python_type: { type: "float", description: "" },
        component: "Number"
      }
    ]);

    const wrapper = new EndpointWrapper(
      "predict",
      endpoint,
      "test/space",
      MockClient as any,
      -1
    );

    mockSubmit.mockImplementation(async function* () {
      yield { type: "data", data: ["response"] };
    });

    await wrapper.call({
      params: {
        name: "test",
        arguments: {
          text_input: "hello",
          "parameter_1": 42
        }
      },
      method: "tools/call"
    }, {} as Server);

    // Verify mixed parameter mapping
    expect(mockSubmit).toHaveBeenCalledWith("predict", {
      text_input: "hello",
      "parameter_1": 42
    });
  });
});