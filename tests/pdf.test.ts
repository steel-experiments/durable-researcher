// ABOUTME: Tests for PDF detection and the fetch+extract pipeline with stubbed parser/fetch.
// ABOUTME: No real PDF files; no real network.

import { describe, it, expect } from "vitest";
import {
  isPdfUrl,
  isPdfContentType,
  extractPdfText,
  fetchAndExtractPdf,
  type PdfParser,
} from "../src/pdf.js";

describe("isPdfUrl", () => {
  it("detects .pdf at the end of a path", () => {
    expect(isPdfUrl("https://example.com/file.pdf")).toBe(true);
    expect(isPdfUrl("https://example.com/path/to/report.PDF")).toBe(true);
  });

  it("detects .pdf followed by a query string", () => {
    expect(isPdfUrl("https://example.com/report.pdf?token=abc")).toBe(true);
  });

  it("returns false for non-PDF URLs", () => {
    expect(isPdfUrl("https://example.com/page.html")).toBe(false);
    expect(isPdfUrl("https://example.com/pdf-page")).toBe(false);
  });

  it("returns false for malformed URLs", () => {
    expect(isPdfUrl("not a url")).toBe(false);
  });
});

describe("isPdfContentType", () => {
  it("matches application/pdf with parameters", () => {
    expect(isPdfContentType("application/pdf")).toBe(true);
    expect(isPdfContentType("application/pdf; charset=utf-8")).toBe(true);
  });

  it("ignores non-PDF content-types and missing values", () => {
    expect(isPdfContentType("text/html")).toBe(false);
    expect(isPdfContentType(null)).toBe(false);
    expect(isPdfContentType(undefined)).toBe(false);
  });
});

describe("extractPdfText (stubbed parser)", () => {
  it("returns the parsed text and propagates page count", async () => {
    const stub: PdfParser = async () => ({ text: "Hello world", numpages: 3 });
    const result = await extractPdfText(new Uint8Array([1, 2, 3]), stub);
    expect(result.text).toBe("Hello world");
    expect(result.numPages).toBe(3);
    expect(result.byteLength).toBe(3);
  });

  it("cleans whitespace and form-feeds in extracted text", async () => {
    const messy = "Line 1\f\nLine   2\n\n\n\nLine 3   ";
    const stub: PdfParser = async () => ({ text: messy });
    const result = await extractPdfText(new Uint8Array([0]), stub);
    expect(result.text).toBe("Line 1\n\nLine 2\n\nLine 3");
  });

  it("returns empty text when the parser throws", async () => {
    const stub: PdfParser = async () => {
      throw new Error("corrupted PDF");
    };
    const result = await extractPdfText(new Uint8Array([0, 1]), stub);
    expect(result.text).toBe("");
    expect(result.byteLength).toBe(2);
  });

  it("refuses to parse PDFs larger than the size cap", async () => {
    let called = false;
    const stub: PdfParser = async () => {
      called = true;
      return { text: "should not run" };
    };
    const huge = new Uint8Array(30 * 1024 * 1024); // 30MB > 25MB cap
    const result = await extractPdfText(huge, stub);
    expect(result.text).toBe("");
    expect(called).toBe(false);
  });
});

describe("fetchAndExtractPdf", () => {
  it("fetches the URL and runs the parser on the bytes", async () => {
    let fetchedUrl: string | undefined;
    const fakeFetch = (async (url: string | URL) => {
      fetchedUrl = String(url);
      return new Response(new Uint8Array([37, 80, 68, 70]), {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }) as unknown as typeof fetch;
    const stubParser: PdfParser = async () => ({ text: "extracted", numpages: 1 });

    const result = await fetchAndExtractPdf("https://example.com/x.pdf", {
      fetchImpl: fakeFetch,
      parser: stubParser,
    });
    expect(fetchedUrl).toBe("https://example.com/x.pdf");
    expect(result?.text).toBe("extracted");
  });

  it("returns null on non-200 responses", async () => {
    const fakeFetch = (async () =>
      new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const result = await fetchAndExtractPdf("https://x.com/y.pdf", { fetchImpl: fakeFetch });
    expect(result).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    const fakeFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const result = await fetchAndExtractPdf("https://x.com/y.pdf", { fetchImpl: fakeFetch });
    expect(result).toBeNull();
  });
});
