// ABOUTME: Tests for parsing orchestrator-plan output into independent subagent workstreams.
// ABOUTME: Pure string parsing — no LLM calls.

import { describe, it, expect } from "vitest";
import { parseWorkstreams } from "../../src/service/workstreams.js";

describe("parseWorkstreams", () => {
  it("extracts WORKSTREAM-marked lines", () => {
    const text = [
      "## Plan",
      "Some preamble prose that should be ignored.",
      "WORKSTREAM: Map the regulatory landscape and primary filings.",
      "WORKSTREAM: Collect benchmark numbers and quantitative comparisons.",
      "WORKSTREAM: Gather criticism and documented failures.",
    ].join("\n");
    expect(parseWorkstreams(text, 5)).toEqual([
      "Map the regulatory landscape and primary filings.",
      "Collect benchmark numbers and quantitative comparisons.",
      "Gather criticism and documented failures.",
    ]);
  });

  it("tolerates leading list markers and numbering before the marker", () => {
    const text = [
      "1. WORKSTREAM: First angle.",
      "- WORKSTREAM: Second angle.",
      "  * workstream: lower-case marker also matches.",
    ].join("\n");
    expect(parseWorkstreams(text, 5)).toEqual([
      "First angle.",
      "Second angle.",
      "lower-case marker also matches.",
    ]);
  });

  it("dedupes case-insensitively and trims whitespace", () => {
    const text = [
      "WORKSTREAM:   Timeline of key actors   ",
      "WORKSTREAM: timeline of key actors",
      "WORKSTREAM: A distinct stream",
    ].join("\n");
    expect(parseWorkstreams(text, 5)).toEqual([
      "Timeline of key actors",
      "A distinct stream",
    ]);
  });

  it("caps the result at max", () => {
    const text = Array.from({ length: 8 }, (_, i) => `WORKSTREAM: angle ${i + 1}`).join("\n");
    expect(parseWorkstreams(text, 3)).toHaveLength(3);
  });

  it("drops empty markers and returns [] when none present", () => {
    expect(parseWorkstreams("WORKSTREAM:   \nplain prose only", 5)).toEqual([]);
    expect(parseWorkstreams("no markers here at all", 5)).toEqual([]);
  });
});
