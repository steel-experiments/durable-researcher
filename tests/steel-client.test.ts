// ABOUTME: Tests for source-authority weighting and filterByRelevance ranking behavior.
// ABOUTME: Verifies primary sources rank above keyword-equivalent explainers/aggregators.

import { describe, it, expect } from "vitest";
import { sourceAuthority, filterByRelevance, scoreRelevance } from "../src/steel-client.js";
import type { SearchResult } from "../src/types.js";

const r = (url: string, title = "title", snippet = ""): SearchResult => ({ url, title, snippet });

describe("sourceAuthority", () => {
  it("boosts SEC and EDGAR domains", () => {
    expect(sourceAuthority("https://www.sec.gov/Archives/edgar/data/123/000123.htm")).toBeGreaterThan(1);
    expect(sourceAuthority("https://efts.sec.gov/LATEST/search-index?q=foo")).toBeGreaterThan(1);
  });

  it("boosts arxiv, NBER, and major journal publishers", () => {
    expect(sourceAuthority("https://arxiv.org/abs/2402.12345")).toBeGreaterThan(1);
    expect(sourceAuthority("https://www.nber.org/papers/w25588")).toBeGreaterThan(1);
    expect(sourceAuthority("https://www.nature.com/articles/abc")).toBeGreaterThan(1);
    expect(sourceAuthority("https://www.science.org/doi/10.1126/science.abc")).toBeGreaterThan(1);
    expect(sourceAuthority("https://www.sciencedirect.com/science/article/pii/S001")).toBeGreaterThan(1);
  });

  it("boosts .edu and .gov domains", () => {
    expect(sourceAuthority("https://economics.stanford.edu/faculty")).toBeGreaterThan(1);
    expect(sourceAuthority("https://www.bls.gov/cps/data.htm")).toBeGreaterThan(1);
    expect(sourceAuthority("https://ec.europa.eu/eurostat/data")).toBeGreaterThan(1);
  });

  it("demotes known explainer / aggregator hosts", () => {
    expect(sourceAuthority("https://medium.com/@foo/why-x")).toBeLessThan(1);
    expect(sourceAuthority("https://www.scribd.com/document/123/Paper")).toBeLessThan(1);
    expect(sourceAuthority("https://stockinvest.us/digest/foo-q1-2025-earnings")).toBeLessThan(1);
    expect(sourceAuthority("https://www.marketscreener.com/quote/STOCK/news/...")).toBeLessThan(1);
    expect(sourceAuthority("https://www.panabee.com/news/foo-q2-2025")).toBeLessThan(1);
    expect(sourceAuthority("https://rebusinessonline.com/foo-bar")).toBeLessThan(1);
    expect(sourceAuthority("https://www.geeksforgeeks.org/foo-tutorial")).toBeLessThan(1);
  });

  it("treats github.io lecture/tutorial paths as low authority", () => {
    expect(sourceAuthority("https://kevinli03.github.io/causal/did3.pdf")).toBeLessThan(1);
    expect(sourceAuthority("https://someone.github.io/tutorials/dl-intro")).toBeLessThan(1);
  });

  it("returns 1.0 for neutral and unrecognized URLs", () => {
    expect(sourceAuthority("https://example.com/page")).toBe(1.0);
    expect(sourceAuthority("https://www.somecompany.com/about")).toBe(1.0);
  });

  it("returns 1.0 for malformed URLs without throwing", () => {
    expect(sourceAuthority("not a url")).toBe(1.0);
    expect(sourceAuthority("")).toBe(1.0);
  });
});

describe("filterByRelevance with source-authority weighting", () => {
  const topic = "quantum error correction surface codes";

  it("ranks primary sources above keyword-equivalent explainer pages", () => {
    const primary = r(
      "https://www.nature.com/articles/quantum-error-correction-surface-codes",
      "Surface codes for quantum error correction",
    );
    const explainer = r(
      "https://medium.com/@foo/quantum-error-correction-surface-codes-explained",
      "Surface codes for quantum error correction",
    );
    const ranked = filterByRelevance([explainer, primary], topic, 0.2);
    expect(ranked[0]).toBe(primary);
    expect(ranked[1]).toBe(explainer);
  });

  it("still drops sub-threshold results regardless of authority bonus", () => {
    // arxiv URL with completely off-topic title — keyword score is 0, authority can't save it
    const offTopic = r(
      "https://arxiv.org/abs/2402.12345",
      "Unrelated cookies recipe",
    );
    const ranked = filterByRelevance([offTopic], topic, 0.3);
    expect(ranked).toEqual([]);
  });

  it("does not promote spammy hosts above primary on identical keyword match", () => {
    const stockSpam = r(
      "https://stockinvest.us/digest/quantum-error-correction-surface-codes",
      "Quantum error correction surface codes",
    );
    const sec = r(
      "https://www.sec.gov/quantum-error-correction-surface-codes-paper",
      "Quantum error correction surface codes",
    );
    const ranked = filterByRelevance([stockSpam, sec], topic, 0.2);
    expect(ranked.indexOf(sec)).toBeLessThan(ranked.indexOf(stockSpam));
  });

  it("preserves existing behavior when no authority signals apply", () => {
    const a = r("https://example.com/a", "quantum error correction surface");
    const b = r("https://example.com/b", "surface codes quantum");
    const ranked = filterByRelevance([a, b], topic, 0.2);
    // Both should pass and both have keyword overlap; ordering follows the keyword scores
    expect(ranked.length).toBe(2);
  });

  it("scoreRelevance itself is unchanged (authority only applied at filter time)", () => {
    const sec = r("https://www.sec.gov/x", "quantum error correction surface");
    const score = scoreRelevance(sec, topic);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});
