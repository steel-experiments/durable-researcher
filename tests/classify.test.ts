// ABOUTME: Tests for the task-mode classifier — pure parsing + stubbed LLM orchestration.
// ABOUTME: No real LLM calls; the classifier accepts an injectable classifier function.

import { describe, it, expect } from "vitest";
import {
  parseClassification,
  classifyTask,
  TASK_MODES,
  type ModeClassifier,
} from "../src/classify.js";

describe("parseClassification", () => {
  it("recognises canonical mode strings", () => {
    expect(parseClassification("lookup")).toBe("lookup");
    expect(parseClassification("extraction")).toBe("extraction");
    expect(parseClassification("synthesis")).toBe("synthesis");
  });

  it("is case-insensitive and ignores surrounding whitespace", () => {
    expect(parseClassification("  Lookup  ")).toBe("lookup");
    expect(parseClassification("EXTRACTION")).toBe("extraction");
  });

  it("recognises a single-word mode embedded in a JSON-ish reply", () => {
    expect(parseClassification('{"mode": "lookup"}')).toBe("lookup");
    expect(parseClassification("mode: extraction")).toBe("extraction");
  });

  it("falls back to null on unknown output", () => {
    expect(parseClassification("retrieval")).toBeNull();
    expect(parseClassification("")).toBeNull();
    expect(parseClassification("I'm not sure")).toBeNull();
  });

  it("exposes all three canonical modes", () => {
    expect(new Set(TASK_MODES)).toEqual(new Set(["lookup", "extraction", "synthesis"]));
  });
});

describe("classifyTask (with stubbed classifier)", () => {
  it("returns the classifier's verdict when it is a known mode", async () => {
    const classifier: ModeClassifier = async () => "extraction";
    const mode = await classifyTask({ topic: "Apple Q3 2025 revenue", classifier });
    expect(mode).toBe("extraction");
  });

  it("defaults to synthesis when the classifier returns null", async () => {
    const classifier: ModeClassifier = async () => null;
    const mode = await classifyTask({ topic: "anything", classifier });
    expect(mode).toBe("synthesis");
  });

  it("defaults to synthesis when the classifier throws", async () => {
    const classifier: ModeClassifier = async () => {
      throw new Error("LLM down");
    };
    const mode = await classifyTask({ topic: "anything", classifier });
    expect(mode).toBe("synthesis");
  });

  it("passes the topic through to the classifier", async () => {
    const seen: string[] = [];
    const classifier: ModeClassifier = async (topic) => {
      seen.push(topic);
      return "lookup";
    };
    await classifyTask({ topic: "What is the height of Mount Everest?", classifier });
    expect(seen).toEqual(["What is the height of Mount Everest?"]);
  });
});

describe("extraction-signal heuristic override", () => {
  it("upgrades synthesis to extraction when the prompt has strong extraction signals", async () => {
    // Classifier returns synthesis but the prompt is obviously a financial filing extraction
    const classifier: ModeClassifier = async () => "synthesis";
    const mode = await classifyTask({
      topic:
        "Analyze CME Group's operating cash flow growth from Q1 2024 to Q1 2025. " +
        "Calculate the operating cash flow conversion rate using their 10-Q. " +
        "Determine total outstanding debt from fixed-rate notes.",
      classifier,
    });
    expect(mode).toBe("extraction");
  });

  it("upgrades synthesis to extraction when the prompt names SEC filings", async () => {
    const classifier: ModeClassifier = async () => "synthesis";
    const mode = await classifyTask({
      topic: "Extract revenue, operating income, and free cash flow from Apple's 10-K fiscal 2024.",
      classifier,
    });
    expect(mode).toBe("extraction");
  });

  it("does NOT upgrade pure synthesis topics that happen to mention a year", async () => {
    const classifier: ModeClassifier = async () => "synthesis";
    const mode = await classifyTask({
      topic: "Compare the cultural impact of Bach's fugues with Mozart's symphonies in 2024.",
      classifier,
    });
    expect(mode).toBe("synthesis");
  });

  it("does not override an explicit lookup classification", async () => {
    const classifier: ModeClassifier = async () => "lookup";
    const mode = await classifyTask({
      topic: "What was Apple's revenue in fiscal Q3 2024?",
      classifier,
    });
    expect(mode).toBe("lookup");
  });

  it("keeps extraction when classifier already says extraction", async () => {
    const classifier: ModeClassifier = async () => "extraction";
    const mode = await classifyTask({
      topic: "Pull every cash-flow line from CME's 10-Q.",
      classifier,
    });
    expect(mode).toBe("extraction");
  });
});
