// 索引を手元のファイルから読んで、Worker と同じ forward を EDINET の問い合わせで流す。
// 正解率と、1 件あたりの R2 の読み込み回数・量・処理時間を出す。
//
// usage: pnpm tsx bench/run.ts <manifest.json> <queries.jsonl>
//   manifest.json: 索引の目録 (src/source.ts)。手元で dbt を流した索引は bench/manifest.py で作る
//   queries.jsonl: 1 行に { "truth": 法人番号, "name": 商号, "address": 住所 }
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { ReadLog } from "../src/parquet";
import { forward } from "../src/forward";
import { loadIndex } from "../src/source";
import type { Store } from "../src/store";

type Query = { truth: string; name: string; address: string | null };

const readRange = (path: string, offset: number, length: number): ArrayBuffer => {
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(length);
  readSync(fd, buf, 0, length, offset);
  closeSync(fd);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + length);
};

type Range = { offset?: number; length?: number; suffix?: number };

/** R2 の get (Range つき) だけを、ディレクトリのファイルで置き換える */
const fileBucket = (root: string): Store => ({
  get: async (key: string, options?: { range?: Range }) => {
    const path = join(root, key);
    if (!existsSync(path)) return null;
    const size = statSync(path).size;
    const r = options?.range;
    // R2 と同じく、ファイルより長い suffix や末尾を越える length はファイルの範囲に収める
    const offset = r?.suffix !== undefined ? Math.max(0, size - r.suffix) : (r?.offset ?? 0);
    const length = Math.min(r?.length ?? size - offset, size - offset);
    const arrayBuffer = async () => readRange(path, offset, length);
    return { size, arrayBuffer, text: async () => new TextDecoder().decode(await arrayBuffer()) };
  },
});

const quantile = (xs: number[], q: number) =>
  [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * q)];

const main = async (manifest: string, queriesPath: string) => {
  const queries: Query[] = readFileSync(queriesPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const bucket = fileBucket(dirname(manifest));
  const index = await loadIndex(bucket, basename(manifest));
  const stats = { matched: 0, matchedCorrect: 0, top1: 0, top5: 0 };
  const reads: number[] = [];
  const bytes: number[] = [];
  const ms: number[] = [];
  for (const q of queries) {
    const log: ReadLog = { reads: 0, bytes: 0 };
    const t0 = performance.now();
    const answer = await forward(
      bucket,
      index,
      { name: q.name, address: q.address ?? undefined },
      log,
    );
    ms.push(performance.now() - t0);
    reads.push(log.reads);
    bytes.push(log.bytes);
    const rank = answer.candidates.findIndex((c) => c.corporate_number === q.truth);
    if (rank === 0) stats.top1 += 1;
    if (rank >= 0) stats.top5 += 1;
    if (answer.status === "matched") {
      stats.matched += 1;
      if (rank === 0) stats.matchedCorrect += 1;
    }
  }
  const p = (xs: number[]) => [0.5, 0.9, 0.99].map((q) => Math.round(quantile(xs, q)));
  console.log(JSON.stringify({ n: queries.length, ...stats }));
  console.log(`reads p50/p90/p99: ${p(reads)}`);
  console.log(`KB p50/p90/p99: ${p(bytes.map((b) => b / 1024))}`);
  console.log(`ms p50/p90/p99: ${p(ms)}`);
};

await main(process.argv[2], process.argv[3]);
