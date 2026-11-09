// EDINET の問い合わせで正引きを流し、正解率と、1 件あたりに読んだファイル・処理時間を集める (bench/run.ts・bench/ablate.ts)
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { type AssetLog, type Files, rowReader } from "../src/assets";
import { type City, forward, loadCities, type Rule } from "../src/forward";

export type Query = { truth: string; name: string; address: string | null };
export type Result = {
  n: number;
  matched: number;
  matchedCorrect: number;
  top1: number;
  top5: number;
  reads: number[];
  kb: number[];
  ms: number[];
};

/** 手元の public/data/ を静的アセットの代わりに読む */
export const localFiles =
  (root: string): Files =>
  async (path) => {
    const b = await readFile(join(root, path)).catch(() => null);
    return b ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : null;
  };

export const readQueries = (path: string): Query[] =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

export const loadLocalCities = (files: Files): Promise<City[]> =>
  loadCities(rowReader(files, { reads: 0, bytes: 0 }));

/** off の規則を外して、queries を 1 件ずつ照合する */
export const evaluate = async (
  files: Files,
  cities: readonly City[],
  queries: readonly Query[],
  off: ReadonlySet<Rule> = new Set(),
): Promise<Result> => {
  const r: Result = {
    n: queries.length,
    matched: 0,
    matchedCorrect: 0,
    top1: 0,
    top5: 0,
    reads: [],
    kb: [],
    ms: [],
  };
  for (const q of queries) {
    const log: AssetLog = { reads: 0, bytes: 0 };
    const t0 = performance.now();
    const answer = await forward(
      rowReader(files, log),
      cities,
      { name: q.name, address: q.address ?? undefined },
      off,
    );
    r.ms.push(performance.now() - t0);
    r.reads.push(log.reads);
    r.kb.push(log.bytes / 1024);
    const rank = answer.candidates.findIndex((c) => c.corporate_number === q.truth);
    if (rank === 0) r.top1 += 1;
    if (rank >= 0) r.top5 += 1;
    if (answer.status === "matched") {
      r.matched += 1;
      if (rank === 0) r.matchedCorrect += 1;
    }
  }
  return r;
};

export const quantiles = (xs: number[]): number[] => {
  const s = [...xs].sort((a, b) => a - b);
  return [0.5, 0.9, 0.99].map((q) => Math.round(s[Math.floor((s.length - 1) * q)]));
};
