import { Client } from "@gradio/client";

async function testConnection(spacePath) {
  try {
    console.log(`Connecting to space ${spacePath}...`);
    const client = await Client.connect(spacePath, {
      events: ["data", "status"],
      hf_token: "<add your token here>"
    });
    
    console.log("Connected successfully!");
    const api = await client.view_api();
    console.log("API structure:", api);
  } catch (error) {
    console.error("Connection failed:", error);
  }
}

// Test each space individually
const spaces = [
  "Qwen/Qwen2-72B-Instruct",
  "black-forest-labs/FLUX.1-schnell",
  "shuttleai/shuttle-3.1-aesthetic",
  "hf-audio/whisper-large-v3-turbo"
];

for (const space of spaces) {
  await testConnection(space);
  console.log("\n-------------------\n");
}