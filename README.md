# mcp-hfspace MCP Server 🤗

Connect to [HuggingFace Spaces](https://huggingface.co/)  with minimal configuration needed simply add your spaces and go!.


If no spaces are specified, connects to `evalstate/FLUX.1-schnell` image generator by default.

@llmindset/mcp-hfspace.



## Basic setup

Supply a list of HuggingFace spaces in the arguments. mcp-hfspace will usually be able to find the most appropriate endpoint and automatically configure for usage.

For example: `.../build/index.js Qwen/Qwen2.5-72B-Instruct evalstate/`

It is strongly recommended to set a Working Directory for handling upload and download of images and other file-based content. Do that with the `--work-dir` argument or `MCP_HF_WORK_DIR` environment variable. The current working directory is used by default which for Claude on Windows is `TODO` and on MacOS is `TODO`.

To access private spaces, use `--hf-token` argument or `HF_TOKEN` environment variable to set your HuggingFace token.

## File Handling and Claude Desktop Mode

### Example 1 - Image Generation (Download Image / Claude Vision)

We'll use `shuttle/
By default, files are . Available files in the root of the . 

### Example 2 - Image Recognition

We'll use `big-vision/paligemma-hf` to ask a question of an image. In this case, we don't want to upload the Image to Claude - we'll reference a file in the WORK_DIR. So, we can ask Claude:

`paligemma to identify who is in the picture "bowie.jpg"` -> `Text Output: david bowie`

### Example 3 - Text-to-Speech (Download Audio)

In _Claude Desktop Mode_, the audio file is saved in the WORK_DIR, and Claude is. If not in desktop mode, the file is returned as a Blob to the Client (useful if it supports embedded Audio attachments).

### Example 4 - Speech-to-Text (Upload Audio)

### Example 5 - Image-to-Image



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

**Image-to-Image**

- yanze/PuLID-FLUX

**Text-to-speech:**

- parler-tts/parler_tts
- suno/bark

**Speech-to-text**

- hf-audio/whisper-large-v3-turbo

**Text-to-music**

haoheliu/audioldm2-text2audio-text2music

**Vision Tasks**

- merve/paligemma2-vqav2

## Features

### Claude Desktop Mode

By default, the Server operates in _Claude Desktop Mode_. In this mode, Images are returned directly in the tool responses, while other binaries are saved in the working folder and a message is returned with the URI. 

Text Content is returned as a Text content type.

For other Client deployments, you will probably want the default behaviour so use --desktop-mode=false or CLAUDE_DESKTOP_MODE=false.


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
        "black-forest-labs/FLUX.1-schnell",
        "--work-dir=~/mcp-files/ or x:/temp/mcp-files/",
        "--HF_TOKEN=HF_{optional token}"
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

### Known Issues and Limitations

**mcp-hfspace**

- Content download only works from spaces with Public visibility.
- Endpoints with unnamed parameters are unsupported for the moment.

**Claude Desktop**

- Claude Desktop 0.75 doesn't seem to respond to errors from the MCP Server, timing out instead. For persistent issues, use the MCP Inspector to get a better look at diagnosing what's going wrong. If something suddenly stops working, it's probably a quota issue.
- Claude Desktop seems to use a hard timeout value of 60s, and doesn't seem to use Progress Notifications to manage UX alive. If you are using ZeroGPU spaces, large/heavy jobs may timeout. Check the WORK_DIR for results though; the MCP Server will still capture the result.
