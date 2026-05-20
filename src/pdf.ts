// ABOUTME: PDF detection and text extraction — used by the browse tool when Steel returns a PDF
// ABOUTME: or the URL clearly points to one. Falls back gracefully when extraction fails.

import { PDFParse } from "pdf-parse";

const PDF_FETCH_TIMEOUT_MS = 30_000;
const MAX_PDF_BYTES = 25 * 1024 * 1024; // 25 MB — anything bigger is almost always a data dump, not text

/** Heuristic: does this URL look like a PDF? */
export function isPdfUrl(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return pathname.endsWith(".pdf") || /\.pdf(\?|$)/i.test(url);
  } catch {
    return false;
  }
}

/** Does the response advertise a PDF content-type? */
export function isPdfContentType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  return contentType.toLowerCase().includes("application/pdf");
}

/** Result of a PDF extraction attempt. */
export type PdfExtractResult = {
  text: string;
  /** Total byte length of the source PDF. */
  byteLength: number;
  /** Best-effort number of pages, when the parser surfaces it. */
  numPages?: number;
};

/** Signature for the PDF parser. Injectable so tests can avoid the real pdf-parse module. */
export type PdfParser = (data: Uint8Array) => Promise<{ text: string; numpages?: number }>;

const defaultParser: PdfParser = async (data) => {
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    const pages = (result as { pages?: unknown[] }).pages;
    return {
      text: (result as { text?: string }).text ?? "",
      numpages: Array.isArray(pages) ? pages.length : undefined,
    };
  } finally {
    await parser.destroy();
  }
};

/** Extract text from PDF bytes. Returns empty text on failure (never throws). */
export async function extractPdfText(
  data: Uint8Array,
  parser: PdfParser = defaultParser,
): Promise<PdfExtractResult> {
  try {
    if (data.byteLength > MAX_PDF_BYTES) {
      return { text: "", byteLength: data.byteLength };
    }
    const parsed = await parser(data);
    return {
      text: cleanPdfText(parsed.text),
      byteLength: data.byteLength,
      numPages: parsed.numpages,
    };
  } catch {
    return { text: "", byteLength: data.byteLength };
  }
}

/** Strip excess whitespace and form-feed characters from raw PDF text. */
function cleanPdfText(raw: string): string {
  return raw
    .replace(/\f/g, "\n\n") // page-feed → paragraph break
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Fetch a PDF and extract its text. Returns null on any network or parsing failure. */
export async function fetchAndExtractPdf(
  url: string,
  opts: {
    fetchImpl?: typeof fetch;
    parser?: PdfParser;
    signal?: AbortSignal;
  } = {},
): Promise<PdfExtractResult | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  const timerId = setTimeout(() => controller.abort(), PDF_FETCH_TIMEOUT_MS);

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { "User-Agent": "durable-researcher PDF fetcher" },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const buf = new Uint8Array(await response.arrayBuffer());
    return await extractPdfText(buf, opts.parser);
  } catch {
    return null;
  } finally {
    clearTimeout(timerId);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
  }
}
