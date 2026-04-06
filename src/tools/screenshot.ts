// ABOUTME: screenshot tool — captures a webpage screenshot via Steel Cloud.
// ABOUTME: Returns the hosted screenshot URL as text content for the agent.

import Steel from "steel-sdk";
import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { screenshotUrl } from "../steel-client.js";

const ScreenshotParams = Type.Object({
  url: Type.String({ description: "The URL to capture a screenshot of" }),
});

/** Create a screenshot tool backed by Steel Cloud. */
export function createScreenshotTool(client: Steel): AgentTool<typeof ScreenshotParams> {
  return {
    name: "screenshot",
    label: "Screenshot",
    description:
      "Capture a screenshot of a webpage. Returns the URL of the hosted screenshot image. Use when visual content matters.",
    parameters: ScreenshotParams,
    execute: async (_toolCallId, params) => {
      const imageUrl = await screenshotUrl(client, params.url);

      return {
        content: [
          {
            type: "text" as const,
            text: `Screenshot captured: ${imageUrl}\nSource page: ${params.url}`,
          },
        ],
        details: { url: params.url, imageUrl },
      };
    },
  };
}
