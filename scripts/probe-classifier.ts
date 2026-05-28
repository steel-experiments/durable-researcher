// ABOUTME: Classifier regression check — run on a set of borderline prompts to confirm
// ABOUTME: survey/synthesis/extraction/lookup route correctly and survey doesn't false-positive.

import { classifyTask } from "../src/classify.js";

/** Each prompt with the mode we expect; "mode" is null when we want to print whatever we get. */
const prompts: { topic: string; expect: "lookup" | "extraction" | "synthesis" | "survey" | null; note: string }[] = [
  // Should be survey — clear enumeration intent
  {
    topic:
      "Research the state of human interaction with long-horizon AI agents during live task execution. Identify relevant literature, benchmarks, systems, and metrics.",
    expect: "survey",
    note: "Niko's steerbench prompt — should land on survey",
  },
  { topic: "Survey the landscape of agent benchmarks and steering systems", expect: "survey", note: "explicit survey verb + targets" },
  { topic: "What are all the parameter-efficient fine-tuning methods?", expect: "survey", note: "enumeration intent (no survey verb but 'all the X')" },

  // Should be synthesis — focused arguments / comparisons / explanations
  { topic: "Compare Postgres and DuckDB for analytics workloads", expect: "synthesis", note: "comparison of two named things" },
  { topic: "Should we use RLHF or DPO for alignment?", expect: "synthesis", note: "decision question" },
  { topic: "Explain how MoE routing works in modern LLMs", expect: "synthesis", note: "explain question" },
  { topic: "Why is RLHF expensive?", expect: "synthesis", note: "why question" },
  { topic: "Review the systems we use for monitoring", expect: "synthesis", note: "review verb + only ONE enumeration target — should NOT trip survey heuristic" },
  { topic: "Analyze the privacy tradeoffs of WhatsApp vs Signal", expect: "synthesis", note: "tradeoff analysis" },

  // Should be lookup
  { topic: "What was Apple's revenue in fiscal Q3 2024?", expect: "lookup", note: "single fact" },
  { topic: "How tall is Mount Everest?", expect: "lookup", note: "single fact" },

  // Should be extraction
  { topic: "Extract revenue, operating income, and free cash flow from Apple's 10-K fiscal 2024", expect: "extraction", note: "filing + extract verb" },
  { topic: "Pull every cash-flow line from CME's 10-Q for Q1 2024", expect: "extraction", note: "filing + period marker + pull verb" },

  // Borderline / interesting
  {
    topic: "What benchmarks exist for evaluating long-horizon agent steerability?",
    expect: null,
    note: "borderline — one survey verb + one target ('benchmarks'); should this be survey or synthesis?",
  },
  {
    topic:
      "Identify the key papers, systems, and benchmarks for evaluating mid-execution agent control",
    expect: "survey",
    note: "identify + 3 targets — should clearly be survey",
  },
];

const COL = { reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", dim: "\x1b[2m" };

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

let pass = 0;
let fail = 0;
let advisory = 0;

console.log("\nClassifier probe — mode routing regression check\n");

for (const p of prompts) {
  const mode = await classifyTask({ topic: p.topic });
  const expected = p.expect;
  let marker: string;
  if (expected === null) {
    marker = `${COL.yellow}?  advisory${COL.reset}`;
    advisory++;
  } else if (mode === expected) {
    marker = `${COL.green}✓  pass    ${COL.reset}`;
    pass++;
  } else {
    marker = `${COL.red}✗  FAIL    ${COL.reset}`;
    fail++;
  }
  const expectStr = expected ?? "(advisory)";
  console.log(
    `${marker} got=${pad(mode, 11)} want=${pad(expectStr, 11)} ${COL.dim}${p.note}${COL.reset}\n   ${p.topic.slice(0, 120)}${p.topic.length > 120 ? "…" : ""}\n`,
  );
}

console.log(`Summary: ${pass} pass, ${fail} fail, ${advisory} advisory`);
process.exit(fail > 0 ? 1 : 0);
