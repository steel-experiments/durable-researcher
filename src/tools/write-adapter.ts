// ABOUTME: write_adapter tool — lets the agent author a Python adapter at runtime and run it
// ABOUTME: in the monty sandbox. Errors come back as text so the agent can read them and retry.

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { MontyError } from "@pydantic/monty";
import { MontyRuntime, type AdapterRuntime } from "../code-adapter.js";
import { appendHistory, previewOutput } from "../adapters-history.js";

const WriteAdapterParams = Type.Object({
  source: Type.String({
    description:
      "Logical name of the source you're querying (e.g. 'arxiv', 'crossref', 'fred', 'uspto'). Used for history/promotion review — pick the canonical short name.",
  }),
  purpose: Type.String({
    description:
      "One-line description of what this adapter does — for traces and for whoever later reviews adapters for promotion.",
  }),
  code: Type.String({
    description:
      "Python source. Last expression is returned. See tool description for available host functions, stdlib subset, and gotchas.",
  }),
  inputs: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description:
        "Values injected as Python globals by name. Pass JSON-shaped values (strings, numbers, booleans, arrays, plain objects).",
    }),
  ),
});

const TOOL_DESCRIPTION = [
  "Write and run a Python adapter to query a structured source (arXiv, PubMed,",
  "Crossref, FRED, USPTO, etc.) when no built-in tool fits.",
  "",
  "Available host functions (call directly — do NOT use `await`):",
  "  http_get(url, headers?) -> {status, headers, body_text}",
  "  http_post(url, body, headers?) -> {status, headers, body_text}",
  "  url_encode(value) -> str    # URL-encode one query-string value",
  "  now() -> str                # ISO 8601 timestamp",
  "  log(msg)                    # debug log to the host",
  "",
  "Stdlib available: json, re, datetime, asyncio, typing, sys, os.",
  "NOT available: requests, httpx, urllib, lxml, pandas, feedparser, numpy.",
  "",
  "Critical gotchas:",
  "  • Do NOT use the Python `await` keyword. The sandbox auto-awaits host",
  "    functions. `resp = http_get(url)` works; `resp = await http_get(url)` fails.",
  "  • The value of the last expression in your script is returned. End with",
  "    the value you want (e.g. a list of dicts), NOT an assignment.",
  "  • Inputs are injected as globals by name from the `inputs` parameter.",
  "",
  "Use this when: a structured JSON or XML API is the right primary source and",
  "no built-in tool covers it. Don't use this for general web pages (use",
  "browse_url) or for things web_search / web_search source=edgar already handle.",
].join("\n");

/** Format any error caught from MontyRuntime as agent-readable text. */
function formatError(err: unknown): { type: string; message: string; text: string } {
  if (err instanceof MontyError) {
    const type = (err as MontyError & { exception?: { typeName: string } })
      .exception?.typeName ?? err.constructor.name;
    const display = (() => {
      try {
        return err.display("traceback" as never);
      } catch {
        try {
          return err.display("type-msg" as never);
        } catch {
          return err.message;
        }
      }
    })();
    return { type, message: err.message, text: display };
  }
  const e = err as Error;
  return {
    type: e?.name ?? "Error",
    message: e?.message ?? String(err),
    text: `${e?.name ?? "Error"}: ${e?.message ?? String(err)}`,
  };
}

/** Create the write_adapter tool. Pass a custom runtime for tests. */
export function createWriteAdapterTool(
  runtime: AdapterRuntime = new MontyRuntime(),
): AgentTool<typeof WriteAdapterParams> {
  return {
    name: "write_adapter",
    label: "Write Adapter",
    description: TOOL_DESCRIPTION,
    parameters: WriteAdapterParams,
    execute: async (_toolCallId, params) => {
      const inputs = params.inputs ?? {};
      const ts = new Date().toISOString();
      const t0 = Date.now();

      try {
        const output = await runtime.run(params.code, inputs);
        const durationMs = Date.now() - t0;
        const preview = previewOutput(output);

        appendHistory({
          ts,
          source: params.source,
          purpose: params.purpose,
          code: params.code,
          inputs,
          durationMs,
          outputPreview: preview,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Adapter "${params.source}" ran in ${durationMs}ms. Output:\n${preview}`,
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
          purpose: params.purpose,
          code: params.code,
          inputs,
          durationMs,
          error: { type: formatted.type, message: formatted.message },
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Adapter "${params.source}" failed after ${durationMs}ms.\n\n${formatted.text}\n\nFix the script and call write_adapter again.`,
            },
          ],
          details: { source: params.source, durationMs, error: formatted },
        };
      }
    },
  };
}
