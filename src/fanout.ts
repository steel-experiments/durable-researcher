// ABOUTME: Redundant fan-out orchestration — generate diverse angles on the SAME question,
// ABOUTME: pool per-angle ledgers, escalate the unconfirmed top, then adversarially resolve.

import { decideEscalation, rankAnswerHypotheses, type EscalationDecision } from "./answer-hypotheses.js";
import { resolveAnswerClaims, type AnswerCorrectnessVoter } from "./adversarial-resolution.js";
import { buildCarryForwardSynthesis, type CarryForwardSynthesis } from "./carry-forward-synthesis.js";
import { mergeLedgers } from "./ledger.js";
import type {
  AnswerHypothesis,
  PlanInterpretation,
  ResearchLedger,
  ResolvedAnswer,
} from "./types.js";

export type FanoutAngle = {
  /** Short label for the reading this worker pursues ("literal", "lateral", …). */
  reading: string;
  /** Full worker instruction, including the anti-self-rejection directive. */
  instruction: string;
};

/**
 * The directive that fixes the lone-reasoner self-rejection. Each angle worker is ASSIGNED
 * one reading and told to pursue it fully — it must not abandon its reading because it
 * "seems unlikely". Refuting a reading is another layer's job (the adversarial pass), not
 * the worker's. This is what stops the failure where the model reached "Bubba Gump" and
 * dismissed it with "No, that doesn't make sense for a 5K."
 */
const ANTI_SELF_REJECTION =
  "Pursue THIS interpretation fully and record claims for and against it. Do NOT abandon or dismiss it because it seems unlikely or far-fetched — committing to one reading is your job; refuting it is handled separately.";

/**
 * Turn the planner's interpretations into fan-out angle instructions, capped at `width`.
 * Falls back to a single literal angle when the planner produced no interpretations, so the
 * fan-out always runs at least one worker.
 */
export function interpretationsToAngles(
  question: string,
  interpretations: PlanInterpretation[] | undefined,
  width: number,
): FanoutAngle[] {
  const cap = Math.max(1, width);
  const sourceHints = sourceClassHints(question);
  const sourceHintBlock = sourceHints.length
    ? [``, `Source classes to prioritize:`, ...sourceHints.map((hint) => `- ${hint}`)].join("\n")
    : "";
  if (interpretations && interpretations.length > 0) {
    return interpretations.slice(0, cap).map((interp) => {
      const device = interp.device ? ` (${interp.device})` : "";
      const target = interp.queriesTarget ? `\nSearch focus: ${interp.queriesTarget}` : "";
      return {
        reading: interp.reading,
        instruction: [
          `You are the "${interp.reading}"${device} interpretation worker for this question:`,
          question,
          ``,
          `This reading means: ${interp.meaning}.${target}${sourceHintBlock}`,
          ``,
          ANTI_SELF_REJECTION,
        ].join("\n"),
      };
    });
  }
  return [
    {
      reading: "literal",
      instruction: [
        `Research this question directly and literally:`,
        question + sourceHintBlock,
        ``,
        ANTI_SELF_REJECTION,
      ].join("\n"),
    },
  ];
}

function sourceClassHints(question: string): string[] {
  const q = question.toLowerCase();
  const hints: string[] = [];
  if (/\b(?:5k|race|run|marathon|walk|event)\b/.test(q)) {
    hints.push(
      "race/event result databases and archived calendars",
      "official venue, organizer, or sponsor event pages",
      "local news, community papers, and event listing/review pages with the event title",
    );
  }
  if (/\b(?:company|startup|funding|ceo|founder|product)\b/.test(q)) {
    hints.push("official company pages, filings, press releases, and reputable business databases");
  }
  if (/\b(?:paper|study|benchmark|dataset|model)\b/.test(q)) {
    hints.push("primary papers, benchmark leaderboards, dataset cards, and project documentation");
  }
  return hints;
}

export type RedundantFanoutResult = {
  /** The pooled ledger after fan-out (and escalation, if it ran). */
  ledger: ResearchLedger;
  /** Candidate answers ranked by corroboration. */
  ranked: AnswerHypothesis[];
  /** Whether/why Stage-2 escalation fired. */
  escalation: EscalationDecision;
  /** Per-hypothesis adversarial verdicts (refuted answers retained for carry-forward). */
  resolved: ResolvedAnswer[];
  /** Synthesis input (confirmed answers + refuted-for-transparency block) and confidence. */
  synthesis: CarryForwardSynthesis;
};

/**
 * Run the redundant fan-out and resolve it to a synthesis input. The angle workers run in
 * parallel (a worker that throws is dropped, not fatal); their ledgers are pooled so
 * cross-worker agreement raises independentCorroboration. If the cheap pass leaves the top
 * answer unconfirmed, one Stage-2 escalation worker deep-confirms it and the ledger is
 * re-pooled. Finally every candidate answer faces the adversarial answer-correctness pass,
 * and the surviving + refuted answers are assembled into a carry-forward synthesis input.
 */
export async function runRedundantFanout(input: {
  question: string;
  angles: FanoutAngle[];
  runAngle: (angle: FanoutAngle) => Promise<ResearchLedger>;
  answerRequiredClaimId?: string;
  escalation?: { enabled?: boolean; minCorroboration?: number };
  runEscalation?: (hypothesis: AnswerHypothesis) => Promise<ResearchLedger>;
  voter?: AnswerCorrectnessVoter;
  votesPerClaim?: number;
  refutationsRequired?: number;
  concurrency?: number;
  signal?: AbortSignal;
}): Promise<RedundantFanoutResult> {
  // Stage 1: run every angle in parallel; drop failures so one crashed worker can't sink
  // the whole fan-out (the redundancy is the point).
  const settled = await Promise.allSettled(input.angles.map((angle) => input.runAngle(angle)));
  const ledgers = settled
    .filter((s): s is PromiseFulfilledResult<ResearchLedger> => s.status === "fulfilled")
    .map((s) => s.value);
  let merged = mergeLedgers(ledgers);

  let ranked = rankAnswerHypotheses(merged, input.answerRequiredClaimId);
  const escalation = decideEscalation(ranked, input.escalation ?? {});

  // Stage 2 (Hybrid): spend one full agent only on an unconfirmed top hypothesis.
  if (escalation.escalate && input.runEscalation) {
    input.signal?.throwIfAborted();
    const target = escalation.hypothesis ?? ranked[0];
    if (target) {
      try {
        const escalated = await input.runEscalation(target);
        merged = mergeLedgers([merged, escalated]);
        ranked = rankAnswerHypotheses(merged, input.answerRequiredClaimId);
      } catch {
        // Escalation failure leaves the Stage-1 pool intact rather than sinking the run.
      }
    }
  }

  const resolved = await resolveAnswerClaims({
    question: input.question,
    hypotheses: ranked,
    ledger: merged,
    ...(input.voter ? { voter: input.voter } : {}),
    ...(input.votesPerClaim !== undefined ? { votesPerClaim: input.votesPerClaim } : {}),
    ...(input.refutationsRequired !== undefined ? { refutationsRequired: input.refutationsRequired } : {}),
    ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const synthesis = buildCarryForwardSynthesis({ question: input.question, resolved, ledger: merged });

  return { ledger: merged, ranked, escalation, resolved, synthesis };
}
