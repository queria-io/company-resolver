# Worker

法人名寄せ API（https://company-resolver.queria.io）。Cloudflare Workers で動き、データベースを使わない。索引は Parquet で R2 に置き（Queria のデータセット）、必要な行グループだけを Range リクエストで読む。照合の規則は [../DESIGN.md](../DESIGN.md)。

正引きは企業名（と住所）から法人番号の候補を返す。

```
GET /v1/forward?name=株式会社クエリア&address=東京都千代田区紀尾井町1-3&limit=5
```

応答は `status`（`matched` / `ambiguous` / `candidates` / `not_found`）、`same_name_count`、`candidates`（法人番号・商号・都道府県・市区町村・`evidence`）。ヘッダーの `X-R2-Reads`・`X-R2-Bytes` は、その問い合わせで R2 から読んだ回数とバイト数。

逆引きは法人番号から、その法人の今の状態を返す。商号・フリガナ・法人種別・所在地・lg_code・法人番号の指定年月日に加え、`status`（`active` / `closed`）、閉鎖日と閉鎖の事由、合併の承継先の法人番号、旧商号（`former_names`）と旧所在地（`former_addresses`）を返す。閉鎖した法人も引ける。無ければ 404。旧商号と旧所在地は、法人番号のデータセットが変更履歴を持つ分だけ入る。

```
GET /v1/reverse?corporate_number=1180301018771
```

`/v1/*` は IP ごとに 1 分 300 回まで（`wrangler.jsonc` の `ratelimits`）。

## 索引

リポジトリの直下の dbt のデータセット（Queria の `company_resolver`）。毎月 `.github/workflows/sync.yml` が法人番号のデータセットから作り直す。Worker は DuckLake のカタログを読まず、FDL の `refs/heads/main` が指すバージョンの `files.json` から、テーブルごとの Parquet を引いて直接読む（`src/source.ts`）。置き場は `wrangler.jsonc` の `DATA_SOURCE`。

- `forward.posting`: bigram ごとの法人（商号・法人格・lg_code つき）。`shard` ごとにファイルを分け、bigram と lg_code の順に並べ、行グループは 2,048 行
- `forward.gram`: bigram ごとの出現する法人の数（df）と IDF。`shard` ごとにファイルを分ける
- `forward.city`: 市区町村の lg_code・都道府県名・市区町村名
- `reverse.company`: 逆引き用の法人の一覧。`shard`（法人番号の下 3 桁）ごとにファイルを分け、法人番号の順に並べ、行グループは 2,048 行

bigram の `shard` は、文字のコードポイントの和を 1,024 で割った余り。1 件の問い合わせで R2 を読むのは 2 回の往復で、1 回目に `gram` と `posting` のフッターと `city`、2 回目に `posting` の行グループを読む。逆引きは `company` のフッターと行グループの 2 回。

## コマンド

```bash
pnpm test        # vitest (Workers ランタイム)。索引は test/fixture/ (リポジトリの直下で uv run python worker/test/make-fixture.py)
pnpm typecheck
pnpm check       # oxlint + oxfmt --check
pnpm tsx bench/run.ts <manifest.json> <queries.jsonl>   # 手元の索引で正解率と読み込み量を計測 (手順は ../BENCHMARK.md)
```
