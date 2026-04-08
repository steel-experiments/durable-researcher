// ABOUTME: Pre-research clarification system that asks the user targeted questions.
// ABOUTME: Generates questions via LLM, collects answers via stdin, returns formatted context.

import * as readline from "node:readline";
import { completeSimple, getEnvApiKey } from "@mariozechner/pi-ai";
import { getUtilityModel, getUtilityReasoning } from "./config.js";
import { loadTemplate } from "./prompts.js";

type ClarifyingQuestion = {
  question: string;
  why: string;
};

/** Parse LLM response into clarifying questions. */
export function parseQuestions(text: string): ClarifyingQuestion[] {
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (q: unknown): q is ClarifyingQuestion =>
          typeof q === "object" &&
          q !== null &&
          typeof (q as Record<string, unknown>).question === "string",
      )
      .slice(0, 3);
  } catch {
    return [];
  }
}

/** Generate clarifying questions for a research topic using LLM. */
async function generateQuestions(topic: string): Promise<ClarifyingQuestion[]> {
  const model = getUtilityModel();
  const systemPrompt = await loadTemplate("clarify", { topic });

  const message = await completeSimple(
    model,
    {
      systemPrompt,
      messages: [
        {
          role: "user" as const,
          content: `Research topic: ${topic}`,
          timestamp: Date.now(),
        },
      ],
    },
    {
      maxTokens: 500,
      apiKey: getEnvApiKey(model.provider),
      reasoningEffort: getUtilityReasoning(),
    },
  );

  const text = message.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  return parseQuestions(text);
}

/** Ask a single question via readline and return the answer. */
function ask(
  rl: readline.Interface,
  prompt: string,
): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer.trim()));
  });
}

/**
 * Run the clarification flow: generate questions, ask user, return formatted answers.
 * Returns empty string if no questions could be generated or user skipped all.
 */
export async function runClarification(topic: string): Promise<string> {
  console.log("\nGenerating clarifying questions...\n");

  const questions = await generateQuestions(topic);
  if (questions.length === 0) {
    console.log("Could not generate questions. Proceeding with research.\n");
    return "";
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answers: { question: string; answer: string }[] = [];

  console.log("Answer these questions to narrow the research scope (press Enter to skip):\n");

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    console.log(`  ${i + 1}. ${q.question}`);
    if (q.why) {
      console.log(`     (${q.why})`);
    }
    const answer = await ask(rl, `     > `);
    if (answer) {
      answers.push({ question: q.question, answer });
    }
    console.log("");
  }

  rl.close();

  if (answers.length === 0) {
    console.log("No answers provided. Proceeding with broad research.\n");
    return "";
  }

  const formatted = answers
    .map((a) => `Q: ${a.question}\nA: ${a.answer}`)
    .join("\n\n");

  console.log("Clarifications captured. Starting research...\n");
  return formatted;
}
