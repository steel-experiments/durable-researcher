// ABOUTME: use_adapter tool — runs a blessed Python adapter from src/adapters/<source>.py.
// ABOUTME: Cheaper than write_adapter: agent passes only the source name and inputs, no code-gen.

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { MontyError } from "@pydantic/monty";
import {
  MontyRuntime,
  loadAdapter,
  hasBlessedAdapter,
  listBlessedAdapters,
  type AdapterRuntime,
} from "../code-adapter.js";
import { appendHistory, previewOutput } from "../adapters-history.js";

const UseAdapterParams = Type.Object({
  source: Type.String({
    description:
      "Logical name of the blessed adapter to invoke (e.g. 'arxiv', 'edgar'). See the tool description for the available list.",
  }),
  inputs: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        "Values injected as Python globals by name. Each blessed adapter documents its required inputs at the top of src/adapters/<source>.py.",
    }),
  ),
});

function buildDescription(blessed: string[]): string {
  const lines = [
    "Run a blessed (human-reviewed, version-controlled) Python adapter by name.",
    "Prefer this over `write_adapter` whenever the source you need is in the list",
    "below — it's cheaper (no code-gen tokens) and the adapter is known-good.",
    "",
    blessed.length === 0
      ? "Available blessed adapters: (none yet — use write_adapter)"
      : `Available blessed adapters: ${blessed.join(", ")}`,
    "",
    "Inputs are documented at the top of each src/adapters/<source>.py. If you",
    "need a source that isn't blessed yet, use write_adapter to author one.",
  ];
  return lines.join("\n");
}

/** Format any error thrown by the runtime as agent-readable text. */
function formatError(err: unknown): { type: string; message: string; text: string } {
  if (err instanceof MontyError) {
    const type = (err as MontyError & { exception?: { typeName: string } })
      .exception?.typeName ?? err.constructor.name;
    let display = err.message;
    try {
      display = err.display("traceback" as never);
    } catch {
      try {
        display = err.display("type-msg" as never);
      } catch {
        // fall through to err.message
      }
    }
    return { type, message: err.message, text: display };
  }
  const e = err as Error;
  return {
    type: e?.name ?? "Error",
    message: e?.message ?? String(err),
    text: `${e?.name ?? "Error"}: ${e?.message ?? String(err)}`,
  };
}

/** Create the use_adapter tool. Accept a custom runtime for tests. */
export function createUseAdapterTool(
  runtime: AdapterRuntime = new MontyRuntime(),
): AgentTool<typeof UseAdapterParams> {
  const blessed = listBlessedAdapters();
  return {
    name: "use_adapter",
    label: "Use Adapter",
    description: buildDescription(blessed),
    parameters: UseAdapterParams,
    execute: async (_toolCallId, params) => {
      const inputs = params.inputs ?? {};
      const ts = new Date().toISOString();
      const t0 = Date.now();

      if (!hasBlessedAdapter(params.source)) {
        const available = listBlessedAdapters();
        const text =
          `No blessed adapter for "${params.source}". ` +
          (available.length > 0
            ? `Available: ${available.join(", ")}. `
            : "(no blessed adapters yet) ") +
          `Use write_adapter if you want to author one for this source.`;
        return {
          content: [{ type: "text" as const, text }],
          details: { source: params.source, error: "not_blessed" },
        };
      }

      let code: string;
      try {
        code = loadAdapter(params.source);
      } catch (err) {
        const e = err as Error;
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to load adapter "${params.source}": ${e.message}`,
            },
          ],
          details: { source: params.source, error: e.message },
        };
      }

      try {
        const output = await runtime.run(code, inputs);
        const durationMs = Date.now() - t0;
        const preview = previewOutput(output);

        appendHistory({
          ts,
          source: params.source,
          purpose: `[blessed] use_adapter(${params.source})`,
          code,
          inputs,
          durationMs,
          outputPreview: preview,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Blessed adapter "${params.source}" ran in ${durationMs}ms. Output:\n${preview}`,
            },
          ],
          details: { source: params.source, durationMs, output },
        };
      } catch (err) {
        const durationMs = Date.now() - t0;
        const formatted = formatError(err);

        appendHistory({
          ts,
          source: params.source,
          purpose: `[blessed] use_adapter(${params.source})`,
          code,
          inputs,
          durationMs,
          error: { type: formatted.type, message: formatted.message },
        });

        return {
          content: [
            {
              type: "text" as const,
              text:
                `Blessed adapter "${params.source}" failed after ${durationMs}ms.\n\n` +
                formatted.text +
                `\n\nThis is a regression in the blessed adapter, not your inputs — flag it to the user rather than retrying.`,
            },
          ],
          details: { source: params.source, durationMs, error: formatted },
        };
      }
    },
  };
}
