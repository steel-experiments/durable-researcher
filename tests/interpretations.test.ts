// ABOUTME: Tests for standalone interpretation generation used to seed fan-out angles.

import { describe, expect, it } from "vitest";
import { generateInterpretations } from "../src/interpretations.js";

describe("generateInterpretations", () => {
  it("parses interpretations from the LLM JSON response", async () => {
    const complete = async () =>
      JSON.stringify({
        interpretations: [
          { reading: "literal", meaning: "a race literally named with bubble gum", queriesTarget: "bubble gum 5K" },
          { reading: "lateral", device: "homophone", meaning: "'bubble gum' = 'Bubba Gump'", queriesTarget: "Bubba Gump 5K" },
        ],
      });
    const out = await generateInterpretations("q", { complete });
    expect(out).toHaveLength(2);
    expect(out[1].device).toBe("homophone");
    expect(out[1].queriesTarget).toBe("Bubba Gump 5K");
  });

  it("always yields at least one literal interpretation, even on garbage output", async () => {
    const complete = async () => "not json at all";
    const out = await generateInterpretations("the question", { complete });
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out[0].reading).toBe("literal");
  });

  it("tolerates JSON wrapped in prose", async () => {
    const complete = async () =>
      'Here you go:\n{"interpretations":[{"reading":"literal","meaning":"m"}]}\nThanks';
    const out = await generateInterpretations("q", { complete });
    expect(out[0].meaning).toBe("m");
  });

  it("deterministically adds quoted-phrase homophone readings before LLM readings", async () => {
    const complete = async () =>
      JSON.stringify({
        interpretations: [
          { reading: "literal", meaning: "LLM literal", queriesTarget: "bubble gum 5K" },
        ],
      });

    const out = await generateInterpretations(
      `What was the name of the 5K race that had 'bubble gum' in its title?`,
      { complete },
    );

    expect(out[0]).toMatchObject({ reading: "literal" });
    expect(out[1]).toMatchObject({ reading: "lateral", device: "homophone" });
    expect(out[1].queriesTarget?.toLowerCase()).toContain("bubba gump");
  });
});
