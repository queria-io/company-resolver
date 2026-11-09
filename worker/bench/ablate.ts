// 照合の規則を 1 つずつ外して流し、精度がどれだけ変わるかを出す (DESIGN.md の「照合の規則」)。
// 外しても精度が変わらない規則は消す候補、同じ入力を直している規則はまとめる候補になる
//
// usage: pnpm tsx bench/ablate.ts [--rules <規則,…>] <queries.jsonl> [<queries.jsonl> ...]
//   --rules: 外して測る規則を絞る (既定はすべて)
//   手元の public/data/ (pnpm build:data で置く) を読む。queries.jsonl は bench/make-queries.py の clean.jsonl・typo.jsonl など
import { basename, join } from "node:path";

import { RULES, type Rule } from "../src/forward";
import { evaluate, loadLocalCities, localFiles, readQueries, type Result } from "./evaluate";

const files = localFiles(join(import.meta.dirname, "../public"));
const cities = await loadLocalCities(files);
const args = process.argv.slice(2);
const only = args[0] === "--rules" ? new Set(args[1].split(",")) : null;
const rules = RULES.filter((r) => !only || only.has(r));
const sets = args
  .slice(only ? 2 : 0)
  .map((p) => ({ name: basename(p, ".jsonl"), queries: readQueries(p) }));

const cell = (r: Result, base: Result, key: "top1" | "top5" | "matched" | "matchedCorrect") => {
  const d = r[key] - base[key];
  return d === 0 ? `${r[key]}` : `${r[key]} (${d > 0 ? "+" : ""}${d})`;
};

console.log("| 外した規則 | 入力 | 上位 1 件 | 上位 5 件 | matched | matched のうち正解 |");
console.log("|---|---|---|---|---|---|");
for (const set of sets) {
  const base = await evaluate(files, cities, set.queries);
  const rows: [string, Result][] = [["(なし)", base]];
  for (const rule of rules) {
    rows.push([rule, await evaluate(files, cities, set.queries, new Set<Rule>([rule]))]);
  }
  for (const [label, r] of rows) {
    console.log(
      `| ${label} | ${set.name} | ${cell(r, base, "top1")} | ${cell(r, base, "top5")} | ${cell(r, base, "matched")} | ${cell(r, base, "matchedCorrect")} |`,
    );
  }
}
