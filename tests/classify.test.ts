// ABOUTME: Tests for the task-mode classifier — pure parsing + stubbed LLM orchestration.
// ABOUTME: No real LLM calls; the classifier accepts an injectable classifier function.

import { describe, it, expect, afterEach } from "vitest";
import {
  parseClassification,
  classifyTask,
  hasLookupSignals,
  hasSurveySignals,
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

  it("exposes all four canonical modes", () => {
    expect(new Set(TASK_MODES)).toEqual(new Set(["lookup", "extraction", "synthesis", "survey"]));
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

describe("lookup-signal heuristic override", () => {
  const greatAmericaTopic =
    "What was the name of the 5K race hosted at the old Great America theme park in California that had 'bubble gum' in its title?";

  it("fires on one-fact name questions", () => {
    expect(hasLookupSignals(greatAmericaTopic)).toBe(true);
    expect(hasLookupSignals("What was the name of the restaurant sponsor?")).toBe(true);
  });

  it("upgrades synthesis to lookup for one-fact name questions", async () => {
    const classifier: ModeClassifier = async () => "synthesis";
    const mode = await classifyTask({ topic: greatAmericaTopic, classifier });
    expect(mode).toBe("lookup");
  });

  it("does not override explicit survey/extraction/lookup verdicts", async () => {
    expect(await classifyTask({ topic: greatAmericaTopic, classifier: async () => "lookup" })).toBe("lookup");
    expect(await classifyTask({ topic: greatAmericaTopic, classifier: async () => "extraction" })).toBe("extraction");
    expect(await classifyTask({ topic: greatAmericaTopic, classifier: async () => "survey" })).toBe("survey");
  });

  it("does not fire on broad analysis prompts", () => {
    expect(hasLookupSignals("Analyze what caused Great America to close and compare redevelopment options")).toBe(false);
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

describe("parseClassification recognises survey", () => {
  it("recognises the survey mode word", () => {
    expect(parseClassification("survey")).toBe("survey");
    expect(parseClassification('{"mode": "survey"}')).toBe("survey");
  });
});

describe("hasSurveySignals heuristic", () => {
  it("fires on a survey verb plus two enumeration targets", () => {
    expect(
      hasSurveySignals(
        "Research the state of human-agent steering: identify relevant literature, benchmarks, systems, and metrics.",
      ),
    ).toBe(true);
    expect(hasSurveySignals("Survey of agent benchmarks and evaluation datasets")).toBe(true);
  });

  it("does not fire without an enumeration target pair", () => {
    // survey verb but only one target
    expect(hasSurveySignals("Review the systems we use for billing")).toBe(false);
    // enumeration targets but no survey verb
    expect(hasSurveySignals("Which benchmark and dataset should I cite for X?")).toBe(false);
  });

  it("does not fire on a focused synthesis prompt", () => {
    expect(
      hasSurveySignals("Design a benchmark for evaluating whether humans can steer running agents"),
    ).toBe(false);
  });
});

describe("survey-mode routing", () => {
  const surveyTopic =
    "Research the state of human interaction with long-horizon AI agents: " +
    "identify relevant literature, benchmarks, systems, and metrics.";

  it("honors the LLM's survey verdict", async () => {
    const classifier: ModeClassifier = async () => "survey";
    const mode = await classifyTask({ topic: surveyTopic, classifier });
    expect(mode).toBe("survey");
  });

  it("upgrades synthesis to survey via heuristic when the prompt enumerates a research space", async () => {
    const classifier: ModeClassifier = async () => "synthesis";
    const mode = await classifyTask({ topic: surveyTopic, classifier });
    expect(mode).toBe("survey");
  });

  it("does not upgrade focused synthesis prompts that lack enumeration signals", async () => {
    const classifier: ModeClassifier = async () => "synthesis";
    const mode = await classifyTask({
      topic: "Compare Postgres and DuckDB for analytics workloads",
      classifier,
    });
    expect(mode).toBe("synthesis");
  });

  it("prefers extraction over survey when both could fire", async () => {
    const classifier: ModeClassifier = async () => "synthesis";
    // Has survey signals AND extraction signals; extraction is the narrower intent.
    const mode = await classifyTask({
      topic:
        "Survey the literature and benchmarks, then extract revenue and operating income from Apple's 10-K fiscal 2024.",
      classifier,
    });
    expect(mode).toBe("extraction");
  });
});
