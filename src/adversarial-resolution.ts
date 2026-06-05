// ABOUTME: Adversarial answer-correctness pass — N skeptic voters per candidate answer,
// ABOUTME: quorum kill, abstention-safe tally, and carry-forward retention of refuted answers.

import { completeSimple, getEnvApiKey } from "@mariozechner/pi-ai";
import { getUtilityModel, getUtilityReasoning } from "./config.js";
import { supportingExcerptsForClaims } from "./ledger.js";
import type {
  AnswerCorrectnessVote,
  AnswerHypothesis,
  ResearchLedger,
  ResolvedAnswer,
} from "./types.js";

/** Independent skeptic votes cast per candidate answer. */
export const ANSWER_VOTES = 3;
/** Valid dissents needed to kill a candidate answer. */
export const ANSWER_REFUTATIONS_REQUIRED = 2;
/** Max concurrent voter calls. */
export const ANSWER_VOTE_CONCURRENCY = 4;
/** Timeout for a single answer-correctness vote. */
const VOTE_TIMEOUT_MS = 30_000;

/**
 * Verdict function on the ANSWER-CORRECTNESS axis: given the question and a candidate
 * answer (with its backing excerpts), does this actually answer the question? This is
 * distinct from citation grounding — a claim can be perfectly grounded in a source yet
 * still fail as an answer. Injectable for tests.
 */
export type AnswerCorrectnessVoter = (input: {
  question: string;
  candidateAnswer: string;
  excerpts: string[];
}) => Promise<AnswerCorrectnessVote>;

/** Run a small async pool: up to `concurrency` tasks at once. */
async function pMap<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  const n = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

/** Collect the verbatim supporting excerpts backing a hypothesis from the ledger. */
function excerptsForHypothesis(ledger: ResearchLedger, hypothesis: AnswerHypothesis): string[] {
  return supportingExcerptsForClaims(ledger, hypothesis.claimIds).map((e) => e.text);
}

/**
 * Adversarially resolve each candidate answer. For every hypothesis we cast
 * `votesPerClaim` independent skeptic votes on whether it ANSWERS the question; a
 * hypothesis is killed only when a quorum (`refutationsRequired`) of VALID votes refutes
 * it. A voter that throws is an abstention — our infra noise, not evidence — so it never
 * counts toward the quorum, and a hypothesis with too few valid votes survives by default.
 *
 * Every hypothesis is RETAINED with its verdict (carry-forward): the synthesis step needs
 * the killed answers and their reasons too, because the real conclusion often rides in the
 * evidence of a refuted framing (e.g. "title literally says bubble gum" dies, but its
 * evidence names the Bubba Gump / Run Forrest Run race that is the true answer).
 */
export async function resolveAnswerClaims(opts: {
  question: string;
  hypotheses: AnswerHypothesis[];
  ledger: ResearchLedger;
  voter?: AnswerCorrectnessVoter;
  votesPerClaim?: number;
  refutationsRequired?: number;
  concurrency?: number;
  signal?: AbortSignal;
}): Promise<ResolvedAnswer[]> {
  const voter = opts.voter ?? defaultAnswerCorrectnessVoter;
  const votesPerClaim = opts.votesPerClaim ?? ANSWER_VOTES;
  const refutationsRequired = opts.refutationsRequired ?? ANSWER_REFUTATIONS_REQUIRED;
  const concurrency = opts.concurrency ?? ANSWER_VOTE_CONCURRENCY;

  // Flatten (hypothesis × vote) into one ballot list so every vote shares the pool.
  const ballots = opts.hypotheses.flatMap((hypothesis, hIndex) => {
    const excerpts = excerptsForHypothesis(opts.ledger, hypothesis);
    return Array.from({ length: votesPerClaim }, () => ({ hypothesis, hIndex, excerpts }));
  });

  const cast = await pMap(ballots, concurrency, async ({ hypothesis, excerpts }) => {
    opts.signal?.throwIfAborted();
    try {
      return await voter({ question: opts.question, candidateAnswer: hypothesis.answer, excerpts });
    } catch {
      // Voter infra error (timeout/parse) is our failure, not evidence — abstain.
      return null;
    }
  });

  return opts.hypotheses.map((hypothesis, hIndex) => {
    const votes: AnswerCorrectnessVote[] = [];
    ballots.forEach((b, k) => {
      if (b.hIndex !== hIndex) return;
      const v = cast[k];
      if (v) votes.push(v);
    });
    const refutations = votes.filter((v) => v.refuted).length;
    const refuted = votes.length >= refutationsRequired && refutations >= refutationsRequired;
    return { hypothesis, validVotes: votes.length, refutations, refuted, votes };
  });
}

const VOTE_SYSTEM = [
  "You are a skeptical judge deciding whether a CANDIDATE ANSWER actually answers the QUESTION.",
  "",
  "This is NOT a source-grounding check. Even if the supporting quotes are accurate, the answer can still",
  "fail to answer the question. Judge the answer ON ITS MERITS as a response to the exact question asked.",
  "",
  "Return {\"refuted\": true} when:",
  "  (a) The answer does not actually resolve the question as asked, OR",
  "  (b) It relies on an interpretive overreach the question does not license (e.g. claiming a literal",
  "      requirement is met when only a loose/phonetic resemblance holds), OR",
  "  (c) It hedges so heavily it asserts nothing, OR",
  "  (d) It contradicts the supporting quotes.",
  "",
  "Return {\"refuted\": false} ONLY when the answer squarely and defensibly answers the question.",
  "When uncertain, prefer {\"refuted\": true} — a wrong confident answer is worse than escalating doubt.",
  "",
  `Output exactly one JSON object: {"refuted": boolean, "reason": string}. No prose, no preamble.`,
].join("\n");

/** Default answer-correctness voter — utility LLM with a tight JSON-output prompt. */
export const defaultAnswerCorrectnessVoter: AnswerCorrectnessVoter = async ({ question, candidateAnswer, excerpts }) => {
  const model = getUtilityModel();
  const userPrompt = [
    `Question: ${question}`,
    "",
    `Candidate answer: ${candidateAnswer}`,
    "",
    "Supporting quotes (for context only — grounding is already established elsewhere):",
    ...(excerpts.length ? excerpts.map((e, i) => `  ${i + 1}. "${e}"`) : ["  (none)"]),
    "",
    "Output JSON only.",
  ].join("\n");

  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), VOTE_TIMEOUT_MS);
  try {
    const message = await completeSimple(
      model,
      { systemPrompt: VOTE_SYSTEM, messages: [{ role: "user" as const, content: userPrompt, timestamp: Date.now() }] },
      { maxTokens: 256, apiKey: getEnvApiKey(model.provider), reasoning: getUtilityReasoning(), signal: controller.signal },
    );
    const text = message.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const parsed = parseVoteVerdict(text);
    // Abstain rather than fabricate a verdict — an unparseable response is our noise.
    if (!parsed) throw new Error("Could not parse answer-correctness vote");
    return parsed;
  } finally {
    clearTimeout(timerId);
  }
};

function parseVoteVerdict(text: string): AnswerCorrectnessVote | null {
  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { refuted?: unknown; reason?: unknown };
    if (typeof obj.refuted !== "boolean") return null;
    return { refuted: obj.refuted, reason: typeof obj.reason === "string" ? obj.reason : "" };
  } catch {
    return null;
  }
}
