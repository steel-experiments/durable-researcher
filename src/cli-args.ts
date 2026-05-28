// ABOUTME: Argument parsing for the research CLI.
// ABOUTME: Keeps flag/value bookkeeping out of the runtime orchestration entrypoint.

import type { ResearchParams } from "./types.js";

export type ResearchCliArgs = {
  topic?: string;
  depth: NonNullable<ResearchParams["depth"]>;
  maxSources?: number;
  resumeTaskId?: string;
  modelSpec?: string;
  forceNew: boolean;
  forceExtend: boolean;
  forceView: boolean;
  clarify: boolean;
  noTui: boolean;
};

const FLAGS_WITH_VALUES = new Set([
  "--depth",
  "--max-sources",
  "--resume",
  "--model",
  "--show-verification",
]);

export function parseResearchCliArgs(args: string[]): ResearchCliArgs {
  const resumeIndex = args.indexOf("--resume");
  const depthIndex = args.indexOf("--depth");
  const maxSourcesIndex = args.indexOf("--max-sources");
  const modelIndex = args.indexOf("--model");

  const skipNext = new Set<number>();
  args.forEach((arg, i) => {
    if (FLAGS_WITH_VALUES.has(arg)) skipNext.add(i + 1);
  });

  const topic = args.find((arg, i) => !arg.startsWith("--") && !skipNext.has(i));
  const depth = depthIndex >= 0
    ? (args[depthIndex + 1] as ResearchCliArgs["depth"])
    : "standard";
  const maxSources = maxSourcesIndex >= 0
    ? Number.parseInt(args[maxSourcesIndex + 1], 10)
    : undefined;

  return {
    topic,
    depth,
    maxSources,
    resumeTaskId: resumeIndex >= 0 ? args[resumeIndex + 1] : undefined,
    modelSpec: modelIndex >= 0 ? args[modelIndex + 1] : undefined,
    forceNew: args.includes("--new"),
    forceExtend: args.includes("--extend"),
    forceView: args.includes("--view"),
    clarify: args.includes("--clarify"),
    noTui: args.includes("--no-tui"),
  };
}

export function validateResearchCliArgs(parsed: ResearchCliArgs): string | null {
  if (!parsed.resumeTaskId && !parsed.topic) {
    return "No research topic provided.";
  }

  if (!["quick", "standard", "deep"].includes(parsed.depth)) {
    return `Invalid depth "${parsed.depth}". Use quick, standard, or deep.`;
  }

  if (parsed.maxSources !== undefined && (!Number.isFinite(parsed.maxSources) || parsed.maxSources <= 0)) {
    return "Invalid --max-sources value. Use a positive integer.";
  }

  if (parsed.modelSpec !== undefined && !parsed.modelSpec.includes(":")) {
    return "Invalid --model format. Use provider:model (e.g. zai:glm-5.1).";
  }

  return null;
}
