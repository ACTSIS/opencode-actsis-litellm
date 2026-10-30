import os from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { ensureFreshToken } from "./gateway-client.ts";
import { readPluginState } from "./state.ts";
import { readEntry, type ToolContentPart, type ToolDeps, type ToolInfo, type ToolResult } from "./tools.ts";
import {
  IMAGE_DEFAULT_MODEL,
  fetchImageGeneration,
  parseImageArgs,
  saveImageB64,
} from "./image.ts";

/**
 * Image tools (mirror of pi #47). OpenCode commands are prompt templates that
 * delegate to a tool, so the `/image` command surface is the
 * `actsis_litellm_image` tool: it takes the raw command text (prompt plus
 * `--size`) and renders the result as a text summary plus a file part, with
 * the png always persisted so a host that cannot paint the part still has the
 * artifact (decision L2 in odd/tasks/parity-47-48.md).
 */

export interface ImageToolDeps extends ToolDeps {
  /** Override for the png directory (tests); defaults to the OS temp dir. */
  imageSaveDir?: string;
}

export const IMAGE_TOOL_NAME = "actsis_litellm_image";

const IMAGE_INPUT = {
  type: "object" as const,
  properties: {
    args: {
      type: "string" as const,
      description:
        "The image request: the prompt, optionally followed by --size 512|768|1024 (default 512).",
    },
  },
  additionalProperties: false as const,
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Relay-friendly result: summary, the image file part, and the saved path. */
export function imageResultParts(
  label: string,
  filePath: string | undefined,
): ToolContentPart[] {
  const parts: ToolContentPart[] = [{ type: "text", text: label }];
  if (filePath) {
    parts.push({
      type: "file",
      uri: pathToFileURL(filePath).href,
      mime: "image/png",
      name: path.basename(filePath),
    });
    parts.push({
      type: "text",
      text: `![generated image](${filePath})\nSaved copy: ${filePath}`,
    });
  } else {
    parts.push({ type: "text", text: "Image rendered in-session; the png copy could not be written." });
  }
  return parts;
}

export function buildImageToolInfos(deps: ImageToolDeps): ToolInfo[] {
  const {
    stateDir,
    fetchImpl = globalThis.fetch,
    timeout,
    onRefreshed,
  } = deps;

  /** Resolve the gateway URL and a bearer token, or a user-facing reason. */
  const context = async (): Promise<
    { baseUrl: string; token: string } | { reason: string }
  > => {
    const entry = await readEntry(deps);
    if (!entry) {
      return { reason: "Not signed in — run /login and choose ACTSIS LiteLLM." };
    }
    const state = await readPluginState(stateDir);
    if (!state?.gatewayUrl) {
      return { reason: "Gateway URL not configured." };
    }
    if (entry.type === "api") {
      return { baseUrl: state.gatewayUrl, token: entry.key };
    }
    const token = await ensureFreshToken(
      { access: entry.access, refresh: entry.refresh, expires: entry.expires },
      { state, timeoutMs: timeout ?? 30_000, fetchImpl, onRefreshed },
    );
    return { baseUrl: state.gatewayUrl, token };
  };

  const image = async (args?: string): Promise<ToolResult> => {
    let parsed;
    try {
      parsed = parseImageArgs(args ?? "");
    } catch (err) {
      return { content: errorMessage(err) };
    }

    const resolved = await context().catch((err: unknown) => ({
      reason: `Image unavailable: ${errorMessage(err)}`,
    }));
    if ("reason" in resolved) return { content: resolved.reason };

    try {
      const result = await fetchImageGeneration(
        resolved.baseUrl,
        resolved.token,
        { prompt: parsed.prompt, model: parsed.model, size: parsed.size },
        timeout,
        fetchImpl,
      );
      const data = result.images[0];
      let filePath: string | undefined;
      try {
        filePath = await saveImageB64(data, deps.imageSaveDir ?? os.tmpdir());
      } catch {
        // Best effort: the image still renders from the file part.
      }
      return {
        content: imageResultParts(
          `image "${parsed.prompt}" — ${result.model} ${result.size}`,
          filePath,
        ),
        metadata: { model: result.model, size: result.size, filePath },
      };
    } catch (err) {
      return { content: errorMessage(err) };
    }
  };

  return [
    {
      name: IMAGE_TOOL_NAME,
      description:
        "Generate an image through the ACTSIS gateway (stable-diffusion.cpp models; the default " +
        `${IMAGE_DEFAULT_MODEL} renders pixel-art). Input is the user's raw request: the prompt, ` +
        "optionally followed by `--size 512|768|1024`. Generation is synchronous and slow (about " +
        "15-60 s at 512, several minutes at 1024). The result carries the rendered image and the " +
        "saved png path; relay that path to the user.",
      input: IMAGE_INPUT,
      async execute(input) {
        const args = typeof input.args === "string" ? input.args : undefined;
        return image(args);
      },
    },
  ];
}
