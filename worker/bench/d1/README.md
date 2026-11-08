# D1 での正引きの計測

正引きの索引を D1 に入れ、1 回の問い合わせ（batch）で照合したときの精度と応答時間を、R2 の Parquet を読む Worker（`src/forward.ts`）と比較するためのもの。本番の Worker は使わない。

- `build.py`: 索引（手元の dbt の出力の目録か、Queria の `company_resolver` データセット）から、SQLite のファイル・D1 に流す SQL・市区町村の一覧を作る
- `forward-d1.ts`: D1 で照合する。規則は `src/forward.ts` と同じ（商号が同じ法人が 1 件に決まれば matched、それ以外は bigram の索引で検索）
- `run.ts`: 手元の SQLite で EDINET の問い合わせを流し、正解率と処理時間を出す
- `worker.ts`・`wrangler.jsonc`: 計測用の Worker（workers.dev、`company-resolver-d1-test`）

## テーブル

- `company`: 法人番号・商号の本体・法人格・lg_code・商号。商号の本体に索引
- `gram`: bigram ごとの出現する法人の数と IDF
- `posting`: bigram・lg_code・法人番号（主キー、WITHOUT ROWID）

## 手順

```bash
# リポジトリの直下で。データセットから作る
uv run python worker/bench/d1/build.py https://data.queria.io/datasets/queria/company_resolver/ducklake.duckdb worker/bench/d1/out
# 手元で精度と処理時間
cd worker && pnpm tsx bench/d1/run.ts bench/d1/out queries.jsonl
# D1 に入れて計測用の Worker を出す
for f in bench/d1/out/sql/*.sql; do npx wrangler d1 execute company-resolver-d1-test --remote --file "$f" -c bench/d1/wrangler.jsonc; done
npx wrangler deploy -c bench/d1/wrangler.jsonc
```

応答時間は、手元から本番（R2）と計測用の Worker（D1）に同じ問い合わせを流して比較する。

```bash
cd worker && node bench/d1/latency.mjs https://company-resolver.queria.io https://company-resolver-d1-test.flops.workers.dev
```
