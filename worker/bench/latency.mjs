// 正引きの応答時間を、手元から API ごとに計測する。各問い合わせを 6 回流し、2 回目以降の中央値を出す
// usage: node bench/latency.mjs <API の起点> [<API の起点> ...]
//   例: node bench/latency.mjs https://company-resolver.queria.io
import { readFileSync } from "node:fs";

const queries = readFileSync(new URL("latency-queries.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];

for (const origin of process.argv.slice(2)) {
  const all = [];
  for (const q of queries) {
    const url = `${origin}/v1/forward?${new URLSearchParams({ name: q.name, address: q.address })}`;
    const ms = [];
    let headers;
    const errors = new Set();
    for (let i = 0; i < 6; i++) {
      const t0 = performance.now();
      const res = await fetch(url);
      await res.arrayBuffer();
      ms.push(performance.now() - t0);
      headers = res.headers;
      if (res.status !== 200) errors.add(res.status);
    }
    const m = median(ms.slice(1));
    all.push(m);
    const info = ["x-d1-rows-read", "x-r2-reads"]
      .filter((h) => headers.get(h) !== null)
      .map((h) => `${h}=${headers.get(h)}`)
      .concat([...errors].map((s) => `status=${s}`))
      .join(" ");
    console.log(`${origin}\t${q.name}\t${Math.round(m)} ms\t${info}`);
  }
  console.log(`${origin}\tmedian of medians\t${Math.round(median(all))} ms`);
}
