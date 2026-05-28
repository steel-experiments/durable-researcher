// ABOUTME: Tests for research CLI argument parsing.
// ABOUTME: Locks flag/value handling without invoking the full CLI entrypoint.

import { describe, expect, it } from "vitest";
import { parseResearchCliArgs, validateResearchCliArgs } from "../src/cli-args.js";

describe("parseResearchCliArgs", () => {
  it("extracts the topic while skipping flag values", () => {
    const parsed = parseResearchCliArgs([
      "--depth",
      "deep",
      "--max-sources",
      "12",
      "--model",
      "zai:glm-5.1",
      "browser agents",
    ]);

    expect(parsed.topic).toBe("browser agents");
    expect(parsed.depth).toBe("deep");
    expect(parsed.maxSources).toBe(12);
    expect(parsed.modelSpec).toBe("zai:glm-5.1");
  });

  it("parses resume and boolean flags", () => {
    const parsed = parseResearchCliArgs([
      "--resume",
      "task-123",
      "--extend",
      "--view",
      "--new",
      "--clarify",
      "--no-tui",
    ]);

    expect(parsed.resumeTaskId).toBe("task-123");
    expect(parsed.forceExtend).toBe(true);
    expect(parsed.forceView).toBe(true);
    expect(parsed.forceNew).toBe(true);
    expect(parsed.clarify).toBe(true);
    expect(parsed.noTui).toBe(true);
  });

  it("defaults depth to standard", () => {
    expect(parseResearchCliArgs(["topic"]).depth).toBe("standard");
  });
});

describe("validateResearchCliArgs", () => {
  it("requires either a topic or resume task id", () => {
    const parsed = parseResearchCliArgs(["--depth", "quick"]);
    expect(validateResearchCliArgs(parsed)).toContain("No research topic");
  });

  it("rejects invalid depth", () => {
    const parsed = parseResearchCliArgs(["topic", "--depth", "huge"]);
    expect(validateResearchCliArgs(parsed)).toContain("Invalid depth");
  });

  it("rejects non-positive max source values", () => {
    const parsed = parseResearchCliArgs(["topic", "--max-sources", "0"]);
    expect(validateResearchCliArgs(parsed)).toContain("max-sources");
  });

  it("rejects malformed model specs", () => {
    const parsed = parseResearchCliArgs(["topic", "--model", "glm-5.1"]);
    expect(validateResearchCliArgs(parsed)).toContain("model");
  });
});
