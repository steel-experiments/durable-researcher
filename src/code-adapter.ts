// ABOUTME: Sandbox runtime for agent-written Python adapters via @pydantic/monty.
// ABOUTME: Defines the host-function surface (http_get, http_post, now) and a swappable AdapterRuntime.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Monty, runMontyAsync } from "@pydantic/monty";

const ADAPTERS_DIR = join(dirname(fileURLToPath(import.meta.url)), "adapters");

/** Read a blessed Python adapter from src/adapters/<name>.py and return its source. */
export function loadAdapter(name: string): string {
  return readFileSync(join(ADAPTERS_DIR, `${name}.py`), "utf8");
}

/** Does a blessed adapter exist for this source name? */
export function hasBlessedAdapter(name: string): boolean {
  return existsSync(join(ADAPTERS_DIR, `${name}.py`));
}

/** List every blessed adapter currently shipped under src/adapters/. */
export function listBlessedAdapters(): string[] {
  if (!existsSync(ADAPTERS_DIR)) return [];
  return readdirSync(ADAPTERS_DIR)
    .filter((f) => f.endsWith(".py"))
    .map((f) => f.replace(/\.py$/, ""))
    .sort();
}

/** Shape returned to the Python sandbox from http_get / http_post. */
export type HttpResponse = {
  status: number;
  headers: Record<string, string>;
  body_text: string;
};

/** Host functions exposed to agent-written Python. The sandbox can only touch the world through these. */
export type HostFunctions = {
  http_get: (url: string, headers?: Record<string, string>) => Promise<HttpResponse>;
  http_post: (
    url: string,
    body: string,
    headers?: Record<string, string>,
  ) => Promise<HttpResponse>;
  /** URL-encodes a single query-string value. Matches URLSearchParams semantics
   * (space → '+', ',' → '%2C'). Exposed because monty's stdlib has no urllib. */
  url_encode: (value: string) => string;
  now: () => string;
  log: (msg: string) => void;
};

/** Default User-Agent for outbound requests from sandboxed code. */
const DEFAULT_UA = "durable-researcher (research-agent@steelbrowser.com)";

/** Build the default host-function surface backed by global fetch. */
export function defaultHostFunctions(
  overrides: Partial<HostFunctions> = {},
): HostFunctions {
  const http_get: HostFunctions["http_get"] = async (url, headers) => {
    const res = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": DEFAULT_UA, ...(headers ?? {}) },
    });
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers),
      body_text: await res.text(),
    };
  };

  const http_post: HostFunctions["http_post"] = async (url, body, headers) => {
    const res = await fetch(url, {
      method: "POST",
      body,
      headers: { "User-Agent": DEFAULT_UA, ...(headers ?? {}) },
    });
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers),
      body_text: await res.text(),
    };
  };

  return {
    http_get,
    http_post,
    url_encode: (value) => {
      // URLSearchParams encodes a single value the way we want — same wire format
      // EDGAR's URL builder produced before the migration.
      const params = new URLSearchParams();
      params.set("x", value);
      return params.toString().slice(2); // drop "x="
    },
    now: () => new Date().toISOString(),
    log: (msg) => console.log(`[adapter] ${msg}`),
    ...overrides,
  };
}

/** Monty returns Python dicts as JS Maps. Recursively unwrap into plain JSON-shaped objects. */
export function montyToPlain(value: unknown): unknown {
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) {
      obj[String(k)] = montyToPlain(v);
    }
    return obj;
  }
  if (Array.isArray(value)) return value.map(montyToPlain);
  return value;
}

/** Swappable runtime interface — lets us replace monty with Pyodide/Deno later without touching callers. */
export interface AdapterRuntime {
  run<TInputs extends Record<string, unknown>, TOutput = unknown>(
    code: string,
    inputs: TInputs,
    host?: Partial<HostFunctions>,
  ): Promise<TOutput>;
}

/** Resource ceiling applied to every monty execution. Keep tight — adapters are short-lived. */
const DEFAULT_LIMITS = {
  maxDurationSecs: 20,
  maxMemory: 64 * 1024 * 1024,
  maxAllocations: 1_000_000,
} as const;

/** Concrete runtime backed by @pydantic/monty. */
export class MontyRuntime implements AdapterRuntime {
  async run<TInputs extends Record<string, unknown>, TOutput = unknown>(
    code: string,
    inputs: TInputs,
    host: Partial<HostFunctions> = {},
  ): Promise<TOutput> {
    const fns = defaultHostFunctions(host);
    const inputNames = Object.keys(inputs);
    const monty = new Monty(code, { inputs: inputNames });
    // Monty rejects an `inputs` object when no input variables were declared.
    const runOpts: Parameters<typeof runMontyAsync>[1] = {
      externalFunctions: fns as unknown as Record<
        string,
        (...args: unknown[]) => unknown
      >,
      limits: DEFAULT_LIMITS,
      printCallback: (_stream, text) => fns.log(text.trimEnd()),
    };
    if (inputNames.length > 0) {
      runOpts.inputs = inputs as Record<string, unknown>;
    }
    const output = await runMontyAsync(monty, runOpts);
    return montyToPlain(output) as TOutput;
  }
}
