// ABOUTME: Tiny standalone probe to confirm @pydantic/monty works in our Bun runtime.
// ABOUTME: Runs increasingly complex python snippets and prints the output.

import { Monty, runMontyAsync } from "@pydantic/monty";

async function probe(label: string, code: string, inputs: Record<string, unknown>, fns: Record<string, (...args: unknown[]) => unknown> = {}) {
  console.log(`\n=== ${label} ===`);
  console.log(`code: ${code.split("\n")[0]}...`);
  try {
    const m = new Monty(code, { inputs: Object.keys(inputs) });
    const out = await runMontyAsync(m, {
      inputs,
      externalFunctions: fns,
      printCallback: (_s, t) => console.log(`  [py] ${t.trimEnd()}`),
    });
    console.log("output:", out);
  } catch (e) {
    console.error("FAIL:", e instanceof Error ? `${e.name}: ${e.message}` : e);
  }
}

await probe("trivial arithmetic", `x + y`, { x: 1, y: 2 });

await probe("print and final value", `
print("hello from py")
result = 41 + 1
result
`, {});

await probe("call external sync fn", `
v = greet(name)
v
`, { name: "Niko" }, {
  greet: (n: unknown) => `hello ${String(n)}`,
});

await probe("async fn returning primitive", `
data = await fetch_url(url)
data
`, { url: "https://example.com" }, {
  fetch_url: async (u: unknown) => `fetched ${String(u)}`,
});

await probe("async fn returning object", `
data = await fetch_url(url)
data
`, { url: "https://example.com" }, {
  fetch_url: async (u: unknown) => ({ status: 200, url: String(u) }),
});

await probe("sync fn returning object", `
data = fetch_url(url)
data
`, { url: "https://example.com" }, {
  fetch_url: (u: unknown) => ({ status: 200, url: String(u) }),
});

await probe("json parse + dict access", `
import json
parsed = json.loads(blob)
parsed["hits"]["hits"][0]["_source"]["ciks"][0]
`, {
  blob: JSON.stringify({
    hits: { hits: [{ _source: { ciks: ["0001318605"] } }] },
  }),
});
