// ABOUTME: plan_research tool — generates targeted sub-queries and a search strategy.
// ABOUTME: Called once at the start of research to decompose the topic into searchable facets.

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { completeSimple, getEnvApiKey } from "@mariozechner/pi-ai";
import { getUtilityModel, getUtilityReasoning } from "../config.js";
import type { ResearchParams, ResearchPlan } from "../types.js";
import { DEPTH_CONFIG } from "../types.js";
import { loadTemplate } from "../prompts.js";

const PlanParams = Type.Object({});

/** Create a plan_research tool that generates sub-queries for the research topic. */
export function createPlanTool(researchParams: ResearchParams): AgentTool<typeof PlanParams> {
  return {
    name: "plan_research",
    label: "Plan Research",
    description:
      "Generate a structured research plan with targeted sub-queries and search strategy. Call this ONCE at the beginning of your research.",
    parameters: PlanParams,
    execute: async () => {
      const depth = researchParams.depth ?? "standard";
      const config = DEPTH_CONFIG[depth];

      console.log(`    Generating ${depth} research plan (up to ${config.initialQueries} queries)...`);
      const startTime = Date.now();
      const ticker = setInterval(() => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        process.stdout.write(`\r    Waiting for LLM... ${elapsed}s`);
      }, 5_000);
      let plan: Awaited<ReturnType<typeof generateResearchPlan>>;
      try {
        plan = await generateResearchPlan(
          researchParams.topic,
          depth,
          config.initialQueries,
        );
      } finally {
        clearInterval(ticker);
      }
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`    Plan ready (${elapsed}s): ${plan.subQueries.length} queries, strategy: ${plan.searchStrategy}`);

      const formatted = [
        `## Research Plan`,
        ``,
        `**Strategy:** ${plan.searchStrategy}`,
        `**Estimated steps:** ${plan.estimatedSteps}`,
        ``,
        `### Strategic Approach`,
        plan.strategicPlan,
        ``,
        `### Search Queries (${plan.subQueries.length})`,
        ...plan.subQueries.map((q, i) => `${i + 1}. ${q}`),
        ``,
        `Execute these queries using web_search, then browse the most promising results.`,
      ];

      return {
        content: [{ type: "text" as const, text: formatted.join("\n") }],
        details: plan,
      };
    },
  };
}

/** Timeout in ms for the plan LLM call. */
const PLAN_TIMEOUT = 60_000;

/** Use LLM to generate a research plan from the topic. */
async function generateResearchPlan(
  topic: string,
  depth: string,
  maxQueries: number,
): Promise<ResearchPlan> {
  const model = getUtilityModel();
  const systemPrompt = await loadTemplate("plan", {
    maxQueries: String(maxQueries),
    depth,
  });

  try {
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), PLAN_TIMEOUT);

    const message = await completeSimple(model, {
      systemPrompt,
      messages: [
        {
          role: "user" as const,
          content: `Research topic: ${topic}`,
          timestamp: Date.now(),
        },
      ],
    }, {
      maxTokens: 1500,
      apiKey: getEnvApiKey(model.provider),
      reasoning: getUtilityReasoning(),
      signal: controller.signal,
    });

    clearTimeout(timerId);

    const text = message.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    return parsePlanResponse(text, topic, maxQueries);
  } catch (err) {
    console.log(`    Plan LLM call failed (${(err as Error).message}), using fallback queries`);
    return {
      strategicPlan: `Research "${topic}" across multiple dimensions`,
      subQueries: extractQueriesFromText("", topic, maxQueries),
      searchStrategy: "breadth-first",
      estimatedSteps: maxQueries * 2,
    };
  }
}

/** Parse the LLM's plan response into a structured ResearchPlan. */
function parsePlanResponse(
  text: string,
  topic: string,
  maxQueries: number,
): ResearchPlan {
  // Try to extract JSON if the model returned it
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        strategicPlan: parsed.strategicPlan ?? parsed.plan ?? text,
        subQueries: Array.isArray(parsed.subQueries ?? parsed.queries)
          ? (parsed.subQueries ?? parsed.queries).slice(0, maxQueries)
          : extractQueriesFromText(text, topic, maxQueries),
        searchStrategy: parsed.searchStrategy ?? "breadth-first",
        estimatedSteps: parsed.estimatedSteps ?? maxQueries * 2,
      };
    } catch {
      // Fall through to text parsing
    }
  }

  return {
    strategicPlan: text,
    subQueries: extractQueriesFromText(text, topic, maxQueries),
    searchStrategy: "breadth-first",
    estimatedSteps: maxQueries * 2,
  };
}

/** Extract numbered queries from text, with fallback to topic variations. */
function extractQueriesFromText(
  text: string,
  topic: string,
  maxQueries: number,
): string[] {
  // Try to find numbered lines that look like queries
  const lines = text.split("\n");
  const queries: string[] = [];
  for (const line of lines) {
    const match = line.match(/^\s*\d+\.\s*(.+)/);
    if (match) {
      const query = match[1].replace(/^["']|["']$/g, "").trim();
      if (query.length > 5 && query.length < 200) {
        queries.push(query);
      }
    }
  }
  if (queries.length >= 2) {
    return queries.slice(0, maxQueries);
  }

  // Fallback: generate basic variations
  const year = new Date().getFullYear();
  return [
    `${topic} ${year}`,
    `${topic} latest research`,
    `${topic} overview`,
  ].slice(0, maxQueries);
}
