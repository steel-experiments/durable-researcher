// ABOUTME: CLI help text, version output, and interactive prompts for existing-task disambiguation.
// ABOUTME: Pure stdin/stdout — no agent or DB access.

import type { ExistingTask } from "./task-finder.js";

export function printHelp(): void {
  console.log(`
Usage: bun run src/index.ts <topic> [options]
       bun run src/index.ts campaign <topic> [campaign options]

Options:
  --depth <quick|standard|deep>   Research depth (default: standard)
  --max-sources <number>          Maximum sources to consult (default: 20)
  --model <provider:model>        LLM model (default: zai:glm-5.1)
  --resume <task-id>              Resume a specific task by ID
  --clarify                       Ask clarifying questions before researching
  --new                           Start fresh, ignore existing research
  --extend                        Extend prior research with more sources
  --view                          View existing report without re-running
  --list                          List recent research tasks
  --cleanup                       Remove completed/failed/cancelled tasks
  --show-verification <task-id>   Dump per-claim verdicts for a task's verification checkpoints
  --no-tui                        Disable the live TUI; stream logs instead

Examples:
  bun run src/index.ts "quantum error correction advances"
  bun run src/index.ts campaign "future of browser agents" --max-duration 5d --max-tokens 1b
  bun run src/index.ts "impact of AI on journalism" --depth deep
  bun run src/index.ts "quantum error correction" --extend
  bun run src/index.ts "quantum error correction" --view
  bun run src/index.ts --resume 019d6485-29ae-7484-a08e-659bb5a82b8c
  bun run src/index.ts --list
  bun run src/index.ts --cleanup
  bun run src/index.ts --show-verification 019d6485-29ae-7484-a08e-659bb5a82b8c
`);
}

/** Prompt the user to choose what to do when a similar completed task already exists. */
export async function askAction(): Promise<"view" | "extend" | "new"> {
  const rl = (await import("node:readline")).createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolveAnswer) => {
    console.log("\nWhat would you like to do?");
    console.log("  [v] View existing report");
    console.log("  [e] Extend research with more sources");
    console.log("  [n] Start fresh research\n");
    rl.question("Choice (v/e/n): ", (answer) => {
      rl.close();
      const choice = answer.trim().toLowerCase();
      if (choice === "e" || choice === "extend") resolveAnswer("extend");
      else if (choice === "n" || choice === "new") resolveAnswer("new");
      else resolveAnswer("view");
    });
  });
}

/** One-line summary of a task for the --list output. */
export function formatTask(task: ExistingTask): string {
  const age = Math.round((Date.now() - task.createdAt.getTime()) / 60000);
  const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
  return `  ${task.taskId}  "${task.topic}" [${task.status}] (${ageStr}, attempt ${task.attempt}/${task.maxAttempts})`;
}

/** Generate an isolated queue name for a one-off CLI run. */
export function createIsolatedQueueName(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `cli_${Date.now().toString(36)}_${random}`;
}
