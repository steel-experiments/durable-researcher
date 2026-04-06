// ABOUTME: Handlebars template loader for prompt files in the prompts/ directory.
// ABOUTME: Compiles .hbs files on first use and caches the compiled templates.

import Handlebars from "handlebars";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, "..", "prompts");

const templateCache = new Map<string, HandlebarsTemplateDelegate>();

/** Register custom Handlebars helpers. */
function registerHelpers() {
  if (Handlebars.helpers["eq"]) return;
  Handlebars.registerHelper("eq", (a: unknown, b: unknown) => a === b);
}

/** Load and compile a Handlebars template by name (without .hbs extension). */
export async function loadTemplate(
  name: string,
  data: Record<string, unknown>,
): Promise<string> {
  registerHelpers();

  let compiled = templateCache.get(name);
  if (!compiled) {
    const filePath = resolve(PROMPTS_DIR, `${name}.hbs`);
    const source = readFileSync(filePath, "utf-8");
    compiled = Handlebars.compile(source);
    templateCache.set(name, compiled);
  }

  return compiled(data);
}
