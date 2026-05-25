// ABOUTME: Smoke test — exercises the production searchEdgar() path against real SEC EDGAR.
// ABOUTME: Confirms the monty-backed adapter works end-to-end without any test stubs.

import { searchEdgar } from "../src/edgar.js";

const t0 = performance.now();
const results = await searchEdgar("Tesla annual report", {
  forms: ["10-K"],
  limit: 5,
});
const elapsed = Math.round(performance.now() - t0);

console.log(`searchEdgar → ${results.length} results in ${elapsed}ms\n`);
for (const [i, r] of results.entries()) {
  console.log(`${i + 1}. ${r.title}`);
  console.log(`   ${r.url}\n`);
}
