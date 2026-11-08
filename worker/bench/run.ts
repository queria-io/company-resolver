// Worker と同じ forward を、手元の public/data/ (pnpm build:data で置く) を読んで流す。
// EDINET の問い合わせで、正解率と、1 件あたりに読んだファイルの数・量と処理時間を出す
//
// usage: pnpm tsx bench/run.ts <queries.jsonl> [<public/ のディレクトリ>]
//   queries.jsonl: 1 行に { "truth": 法人番号, "name": 商号, "address": 住所 } (bench/make-queries.py)
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type AssetLog, type Files, rowReader } from "../src/assets";
import { forward, loadCities } from "../src/forward";

const quantile = (xs: number[], q: number) =>
  [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * q)];

const main = async (queriesPath: string, root: string) => {
  const files: Files = async (path) => {
    const b = await readFile(join(root, path)).catch(() => null);
    return b ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : null;
  };
  const cities = await loadCities(rowReader(files, { reads: 0, bytes: 0 }));
  const queries: { truth: string; name: string; address: string | null }[] = readFileSync(
    queriesPath,
    "utf8",
  )
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const stats = { matched: 0, matchedCorrect: 0, top1: 0, top5: 0 };
  const ms: number[] = [];
  const reads: number[] = [];
  const kb: number[] = [];
  for (const q of queries) {
    const log: AssetLog = { reads: 0, bytes: 0 };
    const t0 = performance.now();
    const answer = await forward(rowReader(files, log), cities, {
      name: q.name,
      address: q.address ?? undefined,
    });
    ms.push(performance.now() - t0);
    reads.push(log.reads);
    kb.push(log.bytes / 1024);
    const rank = answer.candidates.findIndex((c) => c.corporate_number === q.truth);
    if (rank === 0) stats.top1 += 1;
    if (rank >= 0) stats.top5 += 1;
    if (answer.status === "matched") {
      stats.matched += 1;
      if (rank === 0) stats.matchedCorrect += 1;
    }
  }
  const p = (xs: number[]) => [0.5, 0.9, 0.99].map((x) => Math.round(quantile(xs, x)));
  console.log(JSON.stringify({ n: queries.length, ...stats }));
  console.log(`reads p50/p90/p99: ${p(reads)}  KB: ${p(kb)}  ms: ${p(ms)}`);
};

await main(process.argv[2], process.argv[3] ?? join(import.meta.dirname, "../public"));
