// Worker と同じ forward を、手元の public/data/ (pnpm build:data で置く) を読んで流す。
// EDINET の問い合わせで、正解率と、1 件あたりに読んだファイルの数・量と処理時間を出す
//
// usage: pnpm tsx bench/run.ts <queries.jsonl> [<public/ のディレクトリ>]
//   queries.jsonl: 1 行に { "truth": 法人番号, "name": 商号, "address": 住所 } (bench/make-queries.py)
import { join } from "node:path";

import { evaluate, loadLocalCities, localFiles, quantiles, readQueries } from "./evaluate";

const files = localFiles(process.argv[3] ?? join(import.meta.dirname, "../public"));
const { reads, kb, ms, ...stats } = await evaluate(
  files,
  await loadLocalCities(files),
  readQueries(process.argv[2]),
);
console.log(JSON.stringify(stats));
console.log(`reads p50/p90/p99: ${quantiles(reads)}  KB: ${quantiles(kb)}  ms: ${quantiles(ms)}`);
