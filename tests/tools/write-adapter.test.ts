// ABOUTME: Tests for the write_adapter tool — covers success, runtime error, and history logging.
// ABOUTME: Uses a stub AdapterRuntime so tests stay offline and deterministic.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWriteAdapterTool } from "../../src/tools/write-adapter.js";
import type { AdapterRuntime, HostFunctions } from "../../src/code-adapter.js";

class StubSuccessRuntime implements AdapterRuntime {
  lastCode?: string;
  lastInputs?: Record<string, unknown>;
  constructor(private output: unknown) {}
  async run<T>(
    code: string,
    inputs: Record<string, unknown>,
    _host?: Partial<HostFunctions>,
  ): Promise<T> {
    this.lastCode = code;
    this.lastInputs = inputs;
    return this.output as T;
  }
}

class StubErrorRuntime implements AdapterRuntime {
  constructor(private err: Error) {}
  async run<T>(): Promise<T> {
    throw this.err;
  }
}

/** Switch cwd to a temp dir per test so .adapters/ doesn't pollute the repo. */
let prevCwd: string;
let tmpRoot: string;

beforeEach(() => {
  prevCwd = process.cwd();
  tmpRoot = mkdtempSync(join(tmpdir(), "write-adapter-test-"));
  process.chdir(tmpRoot);
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("write_adapter tool", () => {
  it("runs the script, returns a formatted preview, and logs to history", async () => {
    const runtime = new StubSuccessRuntime([{ title: "Paper A", url: "https://x" }]);
    const tool = createWriteAdapterTool(runtime);

    const result = await tool.execute("call-1", {
      source: "arxiv",
      purpose: "search arXiv for 'durable execution'",
      code: "results = []\nresults",
      inputs: { query: "durable execution" },
    });

    expect(runtime.lastCode).toContain("results = []");
    expect(runtime.lastInputs).toEqual({ query: "durable execution" });

    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(text).toContain('Adapter "arxiv" ran in');
    expect(text).toContain("Paper A");

    const histPath = join(tmpRoot, ".adapters", "history", "arxiv.jsonl");
    expect(existsSync(histPath)).toBe(true);
    const records = readFileSync(histPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(records).toHaveLength(1);
    expect(records[0].source).toBe("arxiv");
    expect(records[0].purpose).toContain("durable execution");
    expect(records[0].error).toBeUndefined();
    expect(records[0].outputPreview).toContain("Paper A");
  });

  it("returns runtime errors as readable text instead of throwing", async () => {
    const runtime = new StubErrorRuntime(
      Object.assign(new Error("NameError: name 'http_gett' is not defined"), {
        name: "MontyRuntimeError",
      }),
    );
    const tool = createWriteAdapterTool(runtime);

    const result = await tool.execute("call-2", {
      source: "broken",
      purpose: "demo error path",
      code: "http_gett('x')",
    });

    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(text).toContain('Adapter "broken" failed');
    expect(text).toContain("http_gett");
    expect(text).toContain("Fix the script and call write_adapter again.");

    const histPath = join(tmpRoot, ".adapters", "history", "broken.jsonl");
    const rec = JSON.parse(readFileSync(histPath, "utf8").trim());
    expect(rec.error).toBeDefined();
    expect(rec.error.message).toContain("http_gett");
  });

  it("sanitizes the source name when writing the history file", async () => {
    const runtime = new StubSuccessRuntime("ok");
    const tool = createWriteAdapterTool(runtime);
    await tool.execute("call-3", {
      source: "../weird/name with spaces",
      purpose: "naming test",
      code: "1",
    });
    const histPath = join(
      tmpRoot,
      ".adapters",
      "history",
      ".._weird_name_with_spaces.jsonl",
    );
    expect(existsSync(histPath)).toBe(true);
  });
});
