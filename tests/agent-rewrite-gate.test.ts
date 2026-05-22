// ABOUTME: Tests for the VERIFY_REWRITE env gate over the verify-then-rewrite loop.
// ABOUTME: Verifies the rewrite path is opt-in while the verification metric is still emitted.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, UserMessage } from "@mariozechner/pi-ai";
import { getVerifyRewriteEnabled } from "../src/config.js";
import { shouldRewriteReport, buildResult } from "../src/agent.js";
import type { VerificationResult } from "../src/tools/verify-claims.js";

const LOW_PASS_RESULT: VerificationResult = {
  claims: [
    {
      claim: "Quantum chips dropped to 0.143% error rate",
      sourceN: 1,
      sourceUrl: "https://acme.com/p1",
      supported: false,
      reason: "no match",
    },
    {
      claim: "Cosmic rays cause most errors",
      sourceN: 2,
      sourceUrl: "https://beta.io/x",
      supported: false,
      reason: "no match",
    },
  ],
  summary: { total: 2, supported: 0, unsupported: 2, passRate: 0 },
};

const HIGH_PASS_RESULT: VerificationResult = {
  claims: [
    {
      claim: "Supported claim",
      sourceN: 1,
      sourceUrl: "https://acme.com/p1",
      supported: true,
      reason: "matches",
    },
  ],
  summary: { total: 1, supported: 1, unsupported: 0, passRate: 1 },
};

describe("getVerifyRewriteEnabled", () => {
  const originalValue = process.env.VERIFY_REWRITE;

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.VERIFY_REWRITE;
    } else {
      process.env.VERIFY_REWRITE = originalValue;
    }
  });

  it("defaults to false when VERIFY_REWRITE is unset", () => {
    delete process.env.VERIFY_REWRITE;
    expect(getVerifyRewriteEnabled()).toBe(false);
  });

  it("returns true for '1'", () => {
    process.env.VERIFY_REWRITE = "1";
    expect(getVerifyRewriteEnabled()).toBe(true);
  });

  it("returns true for 'true' (case-insensitive)", () => {
    process.env.VERIFY_REWRITE = "true";
    expect(getVerifyRewriteEnabled()).toBe(true);
    process.env.VERIFY_REWRITE = "TRUE";
    expect(getVerifyRewriteEnabled()).toBe(true);
    process.env.VERIFY_REWRITE = "True";
    expect(getVerifyRewriteEnabled()).toBe(true);
  });

  it("returns true for 'yes' (case-insensitive)", () => {
    process.env.VERIFY_REWRITE = "yes";
    expect(getVerifyRewriteEnabled()).toBe(true);
    process.env.VERIFY_REWRITE = "YES";
    expect(getVerifyRewriteEnabled()).toBe(true);
  });

  it("returns false for arbitrary strings", () => {
    process.env.VERIFY_REWRITE = "0";
    expect(getVerifyRewriteEnabled()).toBe(false);
    process.env.VERIFY_REWRITE = "false";
    expect(getVerifyRewriteEnabled()).toBe(false);
    process.env.VERIFY_REWRITE = "no";
    expect(getVerifyRewriteEnabled()).toBe(false);
    process.env.VERIFY_REWRITE = "maybe";
    expect(getVerifyRewriteEnabled()).toBe(false);
  });

  it("trims and lowercases the value", () => {
    process.env.VERIFY_REWRITE = "  Yes  ";
    expect(getVerifyRewriteEnabled()).toBe(true);
  });
});

describe("shouldRewriteReport", () => {
  it("returns false when enabled=false even for a low-pass-rate result", () => {
    expect(shouldRewriteReport(LOW_PASS_RESULT, false)).toBe(false);
  });

  it("returns true when enabled=true and the result is below threshold", () => {
    expect(shouldRewriteReport(LOW_PASS_RESULT, true)).toBe(true);
  });

  it("returns false when enabled=true but the result is above threshold", () => {
    expect(shouldRewriteReport(HIGH_PASS_RESULT, true)).toBe(false);
  });

  it("returns false when enabled=false and the result is above threshold", () => {
    expect(shouldRewriteReport(HIGH_PASS_RESULT, false)).toBe(false);
  });
});

describe("buildResult verification snapshot under gating", () => {
  function makeMessages(reportText: string): AgentMessage[] {
    return [
      {
        role: "user",
        content: "Research a thing",
        timestamp: Date.now(),
      } satisfies UserMessage,
      {
        role: "assistant",
        content: [{ type: "text", text: reportText }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "test-model",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "endTurn",
        timestamp: Date.now(),
      } satisfies AssistantMessage,
    ];
  }

  it("populates verification metric with rewriteTriggered=false when the gate is off", () => {
    const result = buildResult(
      [],
      "topic",
      makeMessages("Final report text [1]."),
      { result: LOW_PASS_RESULT, attempts: 1, rewriteTriggered: false },
    );
    expect(result.verification).toBeDefined();
    expect(result.verification?.attempts).toBe(1);
    expect(result.verification?.passRate).toBe(0);
    expect(result.verification?.total).toBe(2);
    expect(result.verification?.supported).toBe(0);
    expect(result.verification?.unsupported).toBe(2);
    expect(result.verification?.rewriteTriggered).toBe(false);
  });

  it("populates verification metric with rewriteTriggered=true when the gate is on and rewrite ran", () => {
    const result = buildResult(
      [],
      "topic",
      makeMessages("Final report text [1]."),
      { result: LOW_PASS_RESULT, attempts: 1, rewriteTriggered: true },
    );
    expect(result.verification?.rewriteTriggered).toBe(true);
    expect(result.verification?.passRate).toBe(0);
  });
});
