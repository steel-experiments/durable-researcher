// ABOUTME: Tests for the record_claims ledger tool.
// ABOUTME: Verifies atomic claim recording, derived confidence, and note projection.

import { describe, expect, it } from "vitest";
import { createResearchLedger } from "../../src/ledger.js";
import { createRecordClaimsTool } from "../../src/tools/record-claims.js";
import type { ResearchNote } from "../../src/types.js";

describe("createRecordClaimsTool", () => {
  it("records atomic claims into the ledger and derives notes for existing consumers", async () => {
    const ledger = createResearchLedger([
      { id: "rq1", question: "What is the score?", status: "open", claimIds: [] },
    ]);
    const notes: ResearchNote[] = [];
    const tool = createRecordClaimsTool(ledger, notes);

    await tool.execute("call-1", {
      claims: [
        {
          text: "Model A scored 91% on Benchmark B.",
          sourceUrl: "https://paper.example/a",
          excerpt: "Model A scored 91% on Benchmark B.",
          tier: "primary" as const,
          requiredClaimIds: ["rq1"],
        },
        {
          text: "Model A scored 91% on Benchmark B.",
          sourceUrl: "https://lab.example/result",
          excerpt: "Benchmark B result: Model A, 91%.",
          tier: "secondary" as const,
          requiredClaimIds: ["rq1"],
        },
      ],
    });

    expect(ledger.claims).toHaveLength(1);
    expect(ledger.claims[0]).toMatchObject({
      status: "supported",
      confidence: "high",
      independentCorroboration: 2,
    });
    expect(ledger.requiredClaims[0].status).toBe("answered");
    expect(notes).toHaveLength(1);
    expect(notes[0].keyExcerpts).toHaveLength(2);
  });

  it("marks a claim contested when contradictory evidence is recorded", async () => {
    const ledger = createResearchLedger();
    const notes: ResearchNote[] = [];
    const tool = createRecordClaimsTool(ledger, notes);

    await tool.execute("call-1", {
      claims: [
        {
          text: "The literal event title contains bubble gum.",
          sourceUrl: "https://source.example/a",
          excerpt: "The event title was Run Forrest Run 5K.",
          supports: false,
          tier: "primary" as const,
        },
        {
          text: "The literal event title contains bubble gum.",
          sourceUrl: "https://source.example/b",
          excerpt: "Bubba Gump hosted the race.",
          supports: true,
          tier: "secondary" as const,
        },
      ],
    });

    expect(ledger.claims[0].status).toBe("contested");
    expect(ledger.claims[0].confidence).toBe("low");
  });

  it("does not count copied syndicated wording as independent corroboration", async () => {
    const ledger = createResearchLedger();
    const notes: ResearchNote[] = [];
    const tool = createRecordClaimsTool(ledger, notes);
    const excerpt = "Model A scored 91% on Benchmark B in the reported evaluation.";

    await tool.execute("call-1", {
      claims: [
        {
          text: "Model A scored 91% on Benchmark B.",
          sourceUrl: "https://wire.example/story",
          excerpt,
          tier: "secondary" as const,
        },
        {
          text: "Model A scored 91% on Benchmark B.",
          sourceUrl: "https://republisher.example/story",
          excerpt,
          tier: "secondary" as const,
        },
      ],
    });

    expect(ledger.claims[0].independentCorroboration).toBe(1);
    expect(ledger.claims[0].confidence).toBe("medium");
  });

  it("caps high confidence when all supporting evidence is stale", async () => {
    const ledger = createResearchLedger();
    const notes: ResearchNote[] = [];
    const tool = createRecordClaimsTool(ledger, notes);

    await tool.execute("call-1", {
      claims: [
        {
          text: "The leaderboard top score is 91%.",
          sourceUrl: "https://archive.example/a",
          excerpt: "The leaderboard top score is 91%.",
          tier: "primary" as const,
          publishedAt: "2019-01-01",
        },
        {
          text: "The leaderboard top score is 91%.",
          sourceUrl: "https://archive2.example/a",
          excerpt: "Leaderboard: top score 91%.",
          tier: "primary" as const,
          publishedAt: "2019-02-01",
        },
      ],
    });

    expect(ledger.claims[0].independentCorroboration).toBe(2);
    expect(ledger.claims[0].confidence).toBe("medium");
    expect(ledger.evidence[0].publishedAt).toBe("2019-01-01");
  });

  it("rejects unsupported negative meta-claims with generic excerpts", async () => {
    const ledger = createResearchLedger();
    const notes: ResearchNote[] = [];
    const tool = createRecordClaimsTool(ledger, notes);

    const result = await tool.execute("call-1", {
      claims: [
        {
          text: "No verifiable source was found confirming a 5K race with 'bubble gum' or 'Bubba Gump' in its name at Great America.",
          sourceUrl: "https://www.greatamericaparks.com",
          excerpt: "Marriott Corporation opened two Marriott's GREAT AMERICA parks.",
          supports: true,
          tier: "secondary" as const,
        },
      ],
    });

    expect(ledger.claims).toHaveLength(0);
    expect(notes).toHaveLength(0);
    expect(result.details.rejectedCount).toBe(1);
    expect(result.content[0].text).toContain("Rejected 1 unsupported negative/meta claim");
  });

  it("allows scoped absence claims when the source excerpt itself says no matches were found", async () => {
    const ledger = createResearchLedger();
    const notes: ResearchNote[] = [];
    const tool = createRecordClaimsTool(ledger, notes);

    await tool.execute("call-1", {
      claims: [
        {
          text: "The race-results search returned no matches for Run Forrest Run 5K.",
          sourceUrl: "https://results.example/search",
          excerpt: "No results found for Run Forrest Run 5K.",
          supports: true,
          tier: "secondary" as const,
        },
      ],
    });

    expect(ledger.claims).toHaveLength(1);
    expect(notes).toHaveLength(1);
  });
});
