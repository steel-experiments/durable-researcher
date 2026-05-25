// ABOUTME: Tests for the use_adapter tool — verifies blessed-adapter lookup, success, and error paths.
// ABOUTME: Uses a stub AdapterRuntime so tests stay offline.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createUseAdapterTool } from "../../src/tools/use-adapter.js";
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

const SRC_ADAPTERS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "adapters",
);
const TEST_ADAPTER_NAME = "use_adapter_test_fixture";
const TEST_ADAPTER_PATH = join(SRC_ADAPTERS, `${TEST_ADAPTER_NAME}.py`);

let prevCwd: string;
let tmpRoot: string;

beforeEach(() => {
  prevCwd = process.cwd();
  tmpRoot = mkdtempSync(join(tmpdir(), "use-adapter-test-"));
  process.chdir(tmpRoot);

  // Write a temporary blessed adapter that hasBlessedAdapter / loadAdapter will find.
  // src/adapters/ is colocated with src/code-adapter.js, so we write into the real dir
  // and clean it up in afterEach.
  mkdirSync(SRC_ADAPTERS, { recursive: true });
  writeFileSync(
    TEST_ADAPTER_PATH,
    "# test fixture — used by use-adapter.test.ts\nresult = {'ok': True}\nresult\n",
    "utf8",
  );
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(tmpRoot, { recursive: true, force: true });
  if (existsSync(TEST_ADAPTER_PATH)) rmSync(TEST_ADAPTER_PATH);
});

describe("use_adapter tool", () => {
  it("returns a clear error when the source isn't blessed", async () => {
    const runtime = new StubSuccessRuntime(null);
    const tool = createUseAdapterTool(runtime);
    const result = await tool.execute("call-1", {
      source: "not-a-real-source-name-xyzzy",
    });
    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(text).toContain('No blessed adapter for "not-a-real-source-name-xyzzy"');
    expect(text).toMatch(/use write_adapter/i);
    // Runtime must NOT have been invoked.
    expect(runtime.lastCode).toBeUndefined();
  });

  it("loads the blessed .py and routes inputs through the runtime", async () => {
    const runtime = new StubSuccessRuntime([{ paper: "x" }]);
    const tool = createUseAdapterTool(runtime);
    const result = await tool.execute("call-2", {
      source: TEST_ADAPTER_NAME,
      inputs: { query: "durable execution", max_results: 3 },
    });

    expect(runtime.lastCode).toContain("test fixture");
    expect(runtime.lastInputs).toEqual({
      query: "durable execution",
      max_results: 3,
    });

    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(text).toContain(`Blessed adapter "${TEST_ADAPTER_NAME}" ran in`);

    // History was written.
    const histPath = join(
      tmpRoot,
      ".adapters",
      "history",
      `${TEST_ADAPTER_NAME}.jsonl`,
    );
    expect(existsSync(histPath)).toBe(true);
    const rec = JSON.parse(readFileSync(histPath, "utf8").trim());
    expect(rec.purpose).toContain("[blessed]");
    expect(rec.outputPreview).toContain("paper");
  });

  it("returns runtime errors as readable text without throwing", async () => {
    const runtime = new StubErrorRuntime(
      Object.assign(new Error("AttributeError: 'NoneType' has no 'foo'"), {
        name: "MontyRuntimeError",
      }),
    );
    const tool = createUseAdapterTool(runtime);
    const result = await tool.execute("call-3", { source: TEST_ADAPTER_NAME });
    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    expect(text).toContain('Blessed adapter "' + TEST_ADAPTER_NAME + '" failed');
    expect(text).toContain("AttributeError");
    // Specifically flag this as a regression in the adapter, not the agent's inputs.
    expect(text).toContain("regression in the blessed adapter");

    const histPath = join(
      tmpRoot,
      ".adapters",
      "history",
      `${TEST_ADAPTER_NAME}.jsonl`,
    );
    const rec = JSON.parse(readFileSync(histPath, "utf8").trim());
    expect(rec.error).toBeDefined();
  });

  it("description lists currently-blessed adapters", () => {
    const tool = createUseAdapterTool();
    expect(tool.description).toContain("Available blessed adapters");
    // edgar.py and arxiv.py already live in src/adapters/ in the real repo.
    expect(tool.description).toMatch(/edgar/);
    expect(tool.description).toMatch(/arxiv/);
    // Our test fixture is also present during the test.
    expect(tool.description).toContain(TEST_ADAPTER_NAME);
  });
});
