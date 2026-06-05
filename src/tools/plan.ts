// ABOUTME: plan_research tool — generates targeted sub-queries and a search strategy.
// ABOUTME: Called once at the start of research to decompose the topic into searchable facets.

import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { completeSimple, getEnvApiKey } from "@mariozechner/pi-ai";
import { getUtilityModel, getUtilityReasoning } from "../config.js";
import type { ResearchParams, ResearchPlan, TaskMode } from "../types.js";
import { DEPTH_CONFIG } from "../types.js";
import { loadTemplate } from "../prompts.js";
import type { ToolProgress } from "../event-bus.js";

const PlanParams = Type.Object({});

/** Create a plan_research tool that generates sub-queries for the research topic. */
export function createPlanTool(
  researchParams: ResearchParams,
  mode: TaskMode,
  progress?: ToolProgress,
): AgentTool<typeof PlanParams> {
  const report = progress ?? ((text: string) => console.log(text));
  // Whether to use the carriage-return ticker. Only safe when we have stdout —
  // in TUI mode `progress` is provided and writes go to the bus, never \r.
  const useStdoutTicker = !progress;
  return {
    name: "plan_research",
    label: "Plan Research",
    description:
      "Generate a structured research plan with targeted sub-queries and search strategy. Call this ONCE at the beginning of your research.",
    parameters: PlanParams,
    execute: async () => {
      const depth = researchParams.depth ?? "standard";
      const config = DEPTH_CONFIG[depth];
      // Survey mode needs more facets to enumerate a whole field — floor at 12.
      const maxQueries = mode === "survey"
        ? Math.max(config.initialQueries, 12)
        : config.initialQueries;

      report(`    Generating ${depth} research plan (up to ${maxQueries} queries)...`);
      const startTime = Date.now();
      const ticker = setInterval(() => {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        if (useStdoutTicker) {
          process.stdout.write(`\r    Waiting for LLM... ${elapsed}s`);
        } else {
          report(`Planning... ${elapsed}s elapsed`);
        }
      }, 5_000);
      let plan: Awaited<ReturnType<typeof generateResearchPlan>>;
      try {
        plan = await generateResearchPlan(
          researchParams.topic,
          depth,
          maxQueries,
          mode,
          report,
        );
      } finally {
        clearInterval(ticker);
      }
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      report(`    Plan ready (${elapsed}s): ${plan.subQueries.length} queries, strategy: ${plan.searchStrategy}`);

      return {
        content: [{ type: "text" as const, text: formatPlan(plan).join("\n") }],
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
  mode: TaskMode,
  report: (text: string) => void = (t) => console.log(t),
): Promise<ResearchPlan> {
  const model = getUtilityModel();
  const systemPrompt = await loadTemplate("plan", {
    maxQueries: String(maxQueries),
    depth,
    mode,
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
    report(`    Plan LLM call failed (${(err as Error).message}), using fallback queries`);
    return {
      requiredClaims: fallbackRequiredClaims(topic),
      strategicPlan: `Research "${topic}" across multiple dimensions`,
      subQueries: extractQueriesFromText("", topic, maxQueries),
      searchStrategy: "breadth-first",
      estimatedSteps: maxQueries * 2,
    };
  }
}

/** Render a plan as the markdown block shown to the agent. */
export function formatPlan(plan: ResearchPlan): string[] {
  const lines = [
    `## Research Plan`,
    ``,
    `**Strategy:** ${plan.searchStrategy}`,
    `**Estimated steps:** ${plan.estimatedSteps}`,
    ``,
  ];

  // Surface the lateral reasoning so the agent searches the decoded readings,
  // not just the user's literal words. Omitted entirely when the planner found
  // nothing oblique, so plain topics stay uncluttered.
  if (plan.interpretations && plan.interpretations.length > 0) {
    lines.push(`### Interpretations`);
    for (const i of plan.interpretations) {
      const tag = i.device ? `${i.reading} / ${i.device}` : i.reading;
      const target = i.queriesTarget ? ` — search: ${i.queriesTarget}` : "";
      lines.push(`- **${tag}:** ${i.meaning}${target}`);
    }
    lines.push(``);
  }

  if (plan.requiredClaims && plan.requiredClaims.length > 0) {
    lines.push(`### Required Claims`);
    for (const item of plan.requiredClaims) {
      lines.push(`- **${item.id}:** ${item.question} (${item.status})`);
    }
    lines.push(``);
  }

  lines.push(
    `### Strategic Approach`,
    plan.strategicPlan,
    ``,
    `### Search Queries (${plan.subQueries.length})`,
    ...plan.subQueries.map((q, i) => `${i + 1}. ${q}`),
    ``,
    `Execute these queries using web_search, then browse the most promising results.`,
  );
  return lines;
}

/** Parse the LLM's plan response into a structured ResearchPlan. */
export function parsePlanResponse(
  text: string,
  topic: string,
  maxQueries: number,
): ResearchPlan {
  // Try to extract JSON if the model returned it
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const parsedRequired = Array.isArray(parsed.requiredClaims)
        ? parsed.requiredClaims.map((item: { id?: unknown; question?: unknown; status?: unknown; claimIds?: unknown }, index: number) => ({
            id: typeof item.id === "string" && item.id.trim() ? item.id : `rq${index + 1}`,
            question: typeof item.question === "string" ? item.question : String(item.question ?? ""),
            status: item.status === "answered" || item.status === "contradicted" ? item.status : "open",
            claimIds: Array.isArray(item.claimIds) ? item.claimIds.filter((id): id is string => typeof id === "string") : [],
          })).filter((item: { question: string }) => item.question.trim().length > 0)
        : fallbackRequiredClaims(topic);
      return {
        interpretations: Array.isArray(parsed.interpretations)
          ? parsed.interpretations
          : undefined,
        requiredClaims: addTopicConstraintClaims(parsedRequired, topic),
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
    requiredClaims: fallbackRequiredClaims(topic),
    strategicPlan: text,
    subQueries: extractQueriesFromText(text, topic, maxQueries),
    searchStrategy: "breadth-first",
    estimatedSteps: maxQueries * 2,
  };
}

function fallbackRequiredClaims(topic: string) {
  return addTopicConstraintClaims([
    {
      id: "rq1",
      question: `Answer the core research question: ${topic}`,
      status: "open" as const,
      claimIds: [],
    },
  ], topic);
}

type PlanRequiredClaim = NonNullable<ResearchPlan["requiredClaims"]>[number];

function addTopicConstraintClaims(
  requiredClaims: PlanRequiredClaim[],
  topic: string,
): PlanRequiredClaim[] {
  const out = [...requiredClaims];
  const existing = new Set(out.map((item) => normalizeRequiredQuestion(item.question)));
  const add = (question: string) => {
    const key = normalizeRequiredQuestion(question);
    if (!key || existing.has(key)) return;
    existing.add(key);
    out.push({
      id: `rq${out.length + 1}`,
      question,
      status: "open",
      claimIds: [],
    });
  };

  const quoted = Array.from(topic.matchAll(/["'“”‘’]([^"'“”‘’]{2,80})["'“”‘’]/g))
    .map((match) => match[1]?.trim())
    .filter((value): value is string => !!value);
  for (const phrase of quoted) {
    add(`Verify how the literal phrase "${phrase}" appears in the answer or source title/name.`);
  }

  const titlePhrase = topic.match(/\b(?:title|name)\b/i);
  if (titlePhrase && quoted.length > 0) {
    for (const phrase of quoted) {
      add(`Verify the final answer's title/name contains or explains the phrase "${phrase}".`);
    }
  }

  return out;
}

function normalizeRequiredQuestion(question: string): string {
  return question.toLowerCase().replace(/\s+/g, " ").trim();
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
