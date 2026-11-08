# Worker

法人名寄せ API。Cloudflare Workers で動き、データベースを使わない。索引は Parquet で R2 に置き、必要な行グループだけを Range リクエストで読む。照合の規則は [../DESIGN.md](../DESIGN.md)。

```
GET /v1/resolve?name=株式会社クエリア&address=東京都千代田区紀尾井町1-3&limit=5
```

応答は `status`（`matched` / `ambiguous` / `candidates` / `not_found`）、`same_name_count`、`candidates`（法人番号・商号・都道府県・市区町村・`evidence`）。ヘッダーの `X-R2-Reads`・`X-R2-Bytes` は、その問い合わせで R2 から読んだ回数とバイト数。

## 索引

`prototype/export_parquet.py` が書き出す。置き場は `wrangler.jsonc` の `INDEX_PREFIX`。

- `posting/shard=NNN.parquet`: bigram ごとの法人（商号・法人格・lg_code つき）。bigram と lg_code の順に並べ、行グループは 4,096 行
- `gram/shard=NNN.parquet`: bigram ごとの出現する法人の数（df）と IDF
- `city.parquet`: 市区町村の lg_code・都道府県名・市区町村名

`NNN` は bigram の文字のコードポイントの和を 256 で割った余り。1 件の問い合わせで R2 を読むのは 2 回の往復で、1 回目に `gram` と `posting` のフッターと `city.parquet`、2 回目に `posting` の行グループを読む。

## コマンド

```bash
pnpm test        # vitest (Workers ランタイム)。索引は test/fixture/ (test/make-fixture.py で作る)
pnpm typecheck
pnpm check       # oxlint + oxfmt --check
pnpm tsx bench/run.ts <index_dir> <queries.jsonl>   # 手元の索引で正解率と読み込み量を計測 (問い合わせは bench/make-queries.py)
```
