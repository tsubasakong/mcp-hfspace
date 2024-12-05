# mcp-hfspace MCP Server

Quick Connect to a HuggingFace Space

This is a TypeScript-based MCP server that implements a simple connector to a HuggingFace Space.

Usage: index.js space_name endpoint_name?

For example: `.../build/index.js Qwen/Qwen2.5-72B-Instruct`

This version is based on "sensible defaults" - this version will return the result[0] appropriately formatted (either as TEXT, IMAGE or RESOURCE based on content type).

Use multiple instances to connect to multiple tools.


Some recommended spaces to try:

- shuttleai/shuttle-3.1-aesthetic
- black-forest-labs/FLUX.1-schnell
- Qwen/Qwen2.5-72B-Instruct


## Optional Configuration

HF_TOKEN environment variable to set your Hugging Face token.

## Development

Install dependencies:
```bash
npm install
```

Build the server:
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
