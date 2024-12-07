import {
  EmbeddedResource,
  ImageContent,
  TextContent,
} from "@modelcontextprotocol/sdk/types.js";
import { ApiReturn } from "./gradio_api.js";
import * as fs from "fs/promises";
import { pathToFileURL } from "url";
import path from "path";
import { config } from "./config.js";
// Simple converter registry
type ContentConverter = (
  component: ApiReturn,
  value: any
) => Promise<TextContent | ImageContent | EmbeddedResource>;

// Type for converter functions that may not succeed
type ConverterFn = (
  component: ApiReturn,
  value: any
) => Promise<TextContent | ImageContent | EmbeddedResource | null>;
// Default converter implementation
const defaultConverter: ConverterFn = async () => null;

export class GradioConverter {
  private static converters: Map<string, ContentConverter> = new Map();

  static register(component: string, converter: ContentConverter) {
    this.converters.set(component, converter);
  }

  static async convert(
    component: ApiReturn,
    value: any
  ): Promise<TextContent | ImageContent | EmbeddedResource> {
    const converter =
      this.converters.get(component.component) ||
      withFallback(defaultConverter);
    return converter(component, value);
  }
}

// Shared text content creator
const createTextContent = (component: ApiReturn, value: any): TextContent => {
  const label = component.label ? `${component.label}: ` : "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return {
    type: "text",
    text: `${label}${text}`,
  };
};

// Wrapper that adds fallback behavior
const withFallback = (converter: ConverterFn): ContentConverter => {
  return async (component: ApiReturn, value: any) => {
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

// Shared utility function for saving files
const saveFile = async (
  arrayBuffer: ArrayBuffer,
  mimeType: string,
  prefix: string
): Promise<string> => {
  const extension = mimeType.split("/")[1] || "bin";
  const filename = `${prefix}_${crypto.randomUUID()}.${extension}`;
  await fs.writeFile(filename, Buffer.from(arrayBuffer), {
    encoding: "binary",
  });
  console.error(`Saved ${prefix} to ${filename}`);
  return filename;
};

const imageConverter: ConverterFn = async (_component, value) => {
  if (!value?.url) return null;
  const { mimeType, base64Data, arrayBuffer } = await convertUrlToBase64(
    value.url,
    "image/png"
  );
  await saveFile(arrayBuffer, mimeType, "downloaded_image");
  return {
    type: "image",
    data: base64Data,
    mimeType,
  };
};

const audioConverter: ConverterFn = async (_component, value) => {
  if (!value?.url) return null;
  const { mimeType, base64Data, arrayBuffer } = await convertUrlToBase64(
    value.url,
    "audio/wav"
  );
  const filename = await saveFile(arrayBuffer, mimeType, "downloaded_audio");
  if (config.claudeDesktopMode) {
    return {
      type: "resource",
      resource: {
        uri: `${pathToFileURL(path.resolve(filename)).href}`,
        mimeType,
        text: `Your audio was succesfully created and is available for playback. Claude does not currently support audio content`,
      },
    };
  } else {
    return {
      type: "resource",
      resource: {
        uri: `${pathToFileURL(path.resolve(filename)).href}`,
        mimeType,
        blob: base64Data,
      },
    };
  }
};

// Register converters with fallback behavior
GradioConverter.register("Image", withFallback(imageConverter));
GradioConverter.register("Audio", withFallback(audioConverter));
GradioConverter.register(
  "Chatbot",
  withFallback(async () => null)
);
