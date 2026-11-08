// 正引きに 1 秒 rate 件の問い合わせを seconds 秒流し、失敗率と応答時間を出す (前の応答を待たずに送る)
// usage: node bench/load.mjs <API の起点> <queries.jsonl> <rate> [seconds]
//   queries.jsonl: 1 行に { "name": 商号, "address": 住所 } (bench/make-queries.py の typo.jsonl など)
import { readFileSync } from "node:fs";

const [origin, path, rate, seconds = "10"] = process.argv.slice(2);
const queries = readFileSync(path, "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const n = Number(rate) * Number(seconds);
const results = [];
const start = performance.now();
await Promise.all(
  Array.from({ length: n }, async (_, i) => {
    await new Promise((r) => setTimeout(r, (i * 1000) / Number(rate)));
    const q = queries[i % queries.length];
    const params = new URLSearchParams({
      name: q.name,
      ...(q.address ? { address: q.address } : {}),
    });
    const t0 = performance.now();
    const status = await fetch(`${origin}/v1/forward?${params}`)
      .then(async (r) => (await r.arrayBuffer(), r.status))
      .catch(() => 0);
    results.push({ status, ms: performance.now() - t0 });
  }),
);
const ms = results.map((r) => r.ms).sort((a, b) => a - b);
const q = (x) => Math.round(ms[Math.floor((ms.length - 1) * x)]);
const failed = results.filter((r) => r.status !== 200);
const statuses = Object.groupBy(failed, (r) => r.status);
console.log(
  `rate ${rate}/s × ${seconds}s: ${results.length} 件, 失敗 ${failed.length} (${((100 * failed.length) / results.length).toFixed(1)}%) ${JSON.stringify(Object.fromEntries(Object.entries(statuses).map(([k, v]) => [k, v.length])))}, ms p50/p90/p99 ${q(0.5)}/${q(0.9)}/${q(0.99)}, 全体 ${((performance.now() - start) / 1000).toFixed(1)}s`,
);
