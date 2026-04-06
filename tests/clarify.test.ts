// ABOUTME: Tests for the pre-research clarification question parsing.
// ABOUTME: Verifies JSON extraction from LLM responses.

import { describe, it, expect } from "vitest";
import { parseQuestions } from "../src/clarify.js";

describe("parseQuestions", () => {
  it("parses valid JSON array of questions", () => {
    const text = `[
      {"question": "Are you interested in recent or historical?", "why": "Narrows time scope"},
      {"question": "Technical or overview?", "why": "Sets depth"},
      {"question": "Any specific companies?", "why": "Focuses search"}
    ]`;

    const questions = parseQuestions(text);
    expect(questions).toHaveLength(3);
    expect(questions[0].question).toBe("Are you interested in recent or historical?");
    expect(questions[1].why).toBe("Sets depth");
  });

  it("extracts JSON from surrounding text", () => {
    const text = `Here are the questions:\n[{"question": "Q1?", "why": "W1"}]\nDone.`;

    const questions = parseQuestions(text);
    expect(questions).toHaveLength(1);
    expect(questions[0].question).toBe("Q1?");
  });

  it("limits to 3 questions", () => {
    const text = JSON.stringify([
      { question: "Q1?", why: "W1" },
      { question: "Q2?", why: "W2" },
      { question: "Q3?", why: "W3" },
      { question: "Q4?", why: "W4" },
    ]);

    const questions = parseQuestions(text);
    expect(questions).toHaveLength(3);
  });

  it("returns empty for invalid JSON", () => {
    expect(parseQuestions("not json")).toEqual([]);
    expect(parseQuestions("")).toEqual([]);
    expect(parseQuestions("{}")).toEqual([]);
  });

  it("filters out entries without question field", () => {
    const text = JSON.stringify([
      { question: "Valid?", why: "Yes" },
      { noQuestion: true },
      { question: "Also valid?", why: "Sure" },
    ]);

    const questions = parseQuestions(text);
    expect(questions).toHaveLength(2);
  });
});
