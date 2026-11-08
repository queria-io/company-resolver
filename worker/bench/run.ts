// D1 と同じ問い合わせを手元の SQLite (build.py の index.sqlite) に流し、正解率と 1 件あたりの処理時間を出す
// usage: pnpm tsx bench/d1/run.ts <出力先 (build.py の第 2 引数)> <queries.jsonl>
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { forwardD1, type Sql } from "./forward-d1";

const quantile = (xs: number[], q: number) =>
  [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * q)];

const main = async (dir: string, queriesPath: string) => {
  const db = new DatabaseSync(join(dir, "index.sqlite"), { readOnly: true });
  const sql: Sql = async (statements) =>
    statements.map(({ sql, params }) => db.prepare(sql).all(...(params as string[])));
  const cities = JSON.parse(readFileSync(join(dir, "city.json"), "utf8"));
  const queries: { truth: string; name: string; address: string | null }[] = readFileSync(
    queriesPath,
    "utf8",
  )
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const stats = { matched: 0, matchedCorrect: 0, top1: 0, top5: 0 };
  const ms: number[] = [];
  for (const q of queries) {
    const t0 = performance.now();
    const answer = await forwardD1(sql, cities, { name: q.name, address: q.address ?? undefined });
    ms.push(performance.now() - t0);
    const rank = answer.candidates.findIndex((c) => c.corporate_number === q.truth);
    if (rank === 0) stats.top1 += 1;
    if (rank >= 0) stats.top5 += 1;
    if (answer.status === "matched") {
      stats.matched += 1;
      if (rank === 0) stats.matchedCorrect += 1;
    }
  }
  console.log(JSON.stringify({ n: queries.length, ...stats }));
  console.log(`ms p50/p90/p99: ${[0.5, 0.9, 0.99].map((q) => Math.round(quantile(ms, q)))}`);
};

await main(process.argv[2], process.argv[3]);
