# mcp-hfspace MCP Server

Connect to [HuggingFace Spaces](https://huggingface.co/) with minimial configuration needed.

Minimal configuration needed, simply add your spaces to the arguments and go! 

If no spaces are specified, connects to `black-forest-labs/FLUX.1-schnell` image generator by default.

## Basic setup

Supply a list of HuggingFace spaces in the arguments. mcp-hfspace will usually be able to find the most appropriate endpoint.

For example: `.../build/index.js Qwen/Qwen2.5-72B-Instruct`

![MIRO/Claude Desktop Screenshot](./2024-12-05-flux-shuttle.png)

### Specifying API Endpoint

If you need, you can specify a specific API Endpoint by adding it to the spacename. So rather than passing in `Qwen/Qwen2.5-72B-Instruct` you would use `Qwen/Qwen2.5-72B-Instruct/model_chat`.

### Specifying HuggingFace Token

`HF_TOKEN` environment variable to set your Hugging Face token.

## Recommended Spaces

Some recommended spaces to try:

- shuttleai/shuttle-3.1-aesthetic
- black-forest-labs/FLUX.1-schnell
- Qwen/Qwen2.5-72B-Instruct
- nicoaspra/Create_PDF_Booklet

**Text-to-speech:**

- parler-tts/parler_tts
- suno/bark

**Speech-to-text**

- hf-audio/whisper-large-v3-turbo

**Text-to-music**

haoheliu/audioldm2-text2audio-text2music

**Vision Tasks**

- merve/paligemma2-vqav2

## Development

Install dependencies:

```bash
npm install
```

Build the server:#

```bash
npm run build
```

For development with auto-rebuild:

```bash
npm run watch
```

## Installation

To use with Claude Desktop, add the server config:

On MacOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
On Windows: `%APPDATA%/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mcp-hfspace": {
      "command": "/path/to/mcp-hfspace/build/index.js"
      "args:" [
        "Qwen/Qwen2-72B-Instruct",
        "black-forest-labs/FLUX.1-schnell"
        ]
    }
  }
}
```

### Debugging

Since MCP servers communicate over stdio, debugging can be challenging. We recommend using the [MCP Inspector](https://github.com/modelcontextprotocol/inspector), which is available as a package script:

```bash
npm run inspector
```

The Inspector will provide a URL to access debugging tools in your browser.
