# Worker

法人名寄せ API（https://company-resolver.queria.io）。Cloudflare Workers で動く。正引きの索引は D1 に、逆引きの索引は Parquet で R2 に置く（どちらも Queria のデータセットから作る）。照合の規則は [../DESIGN.md](../DESIGN.md)。

正引きは企業名（と住所）から法人番号の候補を返す。

```
GET /v1/forward?name=株式会社クエリア&address=東京都千代田区紀尾井町1-3&limit=5
```

`name` と `address` は 200 文字まで。応答は `status`（`matched` / `ambiguous` / `candidates` / `not_found`）、`same_name_count`、`candidates`（法人番号・商号・都道府県・市区町村・`evidence`）。ヘッダーの `X-D1-Rows-Read` は、その問い合わせで D1 から読んだ行数。

複数の企業をまとめて照合するときは、1 回に 20 件までを `POST /v1/forward/batch` に渡す。応答の `results` は、`queries` と同じ順に、1 件ずつの正引きと同じ形の応答を並べたもの。IP ごとに 1 分 10 回まで（`BATCH_LIMITER`）。D1 が混み合って断ったときは 503 と `Retry-After` を返す。

```
POST /v1/forward/batch
{"queries": [{"name": "株式会社クエリア", "address": "東京都千代田区"}, {"name": "クエリア商事株式会社", "limit": 3}]}
```

逆引きは法人番号から、その法人の今の状態を返す。商号・フリガナ・法人種別・所在地・lg_code・法人番号の指定年月日に加え、`status`（`active` / `closed`）、閉鎖日と閉鎖の事由、合併の承継先の法人番号、旧商号（`former_names`）と旧所在地（`former_addresses`）を返す。閉鎖した法人も引ける。無ければ 404。旧商号と旧所在地は、法人番号のデータセットが変更履歴を持つ分だけ入る。

```
GET /v1/reverse?corporate_number=1180301018771
```

ヘッダーの `X-R2-Reads`・`X-R2-Bytes` は、その問い合わせで R2 から読んだ回数とバイト数。

`/v1/*` は IP ごとに 1 分 300 回まで（`wrangler.jsonc` の `ratelimits`）。

## 索引

リポジトリの直下の dbt のデータセット（Queria の `company_resolver`）。毎月 `.github/workflows/sync.yml` が法人番号のデータセットから作り直す。

### 正引き（D1）

`scripts/sync_d1.py` が、FDL の `refs/heads/main` が指すバージョンの `forward` の表（`company_core`・`posting`・`gram`・`city`）を D1（`wrangler.jsonc` の `DB`）に入れる。Sync のあとに同じ workflow の `d1` ジョブが流す。

- `company`: 法人番号ごとの商号の本体・法人格・lg_code・商号。商号の本体に索引
- `posting`: bigram・lg_code・法人番号（主キー）
- `gram`: bigram ごとの出現する法人の数（df）と IDF
- `city`: 市区町村の lg_code・都道府県名・市区町村名。Worker は 5 分ごとに読み直す
- `meta`: 最後に反映したバージョンの ID（`version`）、テーブルの定義のバージョン（`schema`）、反映の途中ならその反映先（`applying`）

正引きは、まず `company` で商号の本体が同じ法人を引く。商号と法人格（住所があれば市区町村も）が一致する法人が 1 件だけなら、それで答える。決まらないときだけ、`gram`・`posting`・`company` で近い商号を引き、候補を編集距離で並べる（D1 への往復は 2 回）。まとめて照合するときは、問い合わせごとの文をそれぞれの往復で 1 つの batch にまとめる。

反映は、`meta` のバージョンと新しいバージョンの `forward.company_core`・`forward.posting` を比べ、変わった行だけを主キーで消す・書く。`gram` と `city` は毎回全部を書き直す。書き終えたら法人数と `posting` の行数を元データと照合し、合っていれば最後に `meta` を書く。途中で失敗したら同じコマンドを流し直せばよい（書き始める前に `meta` の `applying` に反映先のバージョンを書き、流し直す前に main が別のバージョンに進んでいたら全件を入れ直す）。

`meta` の `schema`（`sync_d1.py` の `SCHEMA` から作るテーブルの定義のバージョン）が違うとき、前のバージョンのカタログを読めないとき、`--full` のときは、全件を `company_next` などの別の表に入れ、照合が合ったら今の表と入れ替える。入れ替えるまで正引きは今の表を引く。入れ替えと `meta` の書き込みは 1 回の要求で流すので、途中で失敗しても新旧の表が混ざらない。入れ替えるあいだは、D1 の大きさが一時的に 2 倍になる。

```bash
uv run python scripts/sync_d1.py          # リポジトリの直下で。wrangler login か CLOUDFLARE_API_TOKEN が要る
uv run python scripts/sync_d1.py --full   # 行数が合わないと言われたら全件を入れ直す
```

### 逆引き（R2）

Worker は DuckLake のカタログを読まず、FDL の `refs/heads/main` が指すバージョンの `files.json` から、`reverse.company` の Parquet を引いて直接読む（`src/source.ts`）。置き場は `wrangler.jsonc` の `DATA_SOURCE`。`shard`（法人番号の下 3 桁）ごとにファイルを分け、法人番号の順に並べ、行グループは 2,048 行。逆引きは `company` のフッターと行グループの 2 回読む。

## コマンド

```bash
uv run pytest    # リポジトリの直下で。sync_d1.py の差分の反映が全件の入れ直しと一致するか
pnpm test        # vitest (Workers ランタイム)。索引は test/fixture/ (リポジトリの直下で uv run python worker/test/make-fixture.py)。正引きは forward.sql を D1 に流す
pnpm typecheck
pnpm check       # oxlint + oxfmt --check
pnpm tsx bench/run.ts <index.sqlite> <queries.jsonl>   # 手元の SQLite で正解率と処理時間を計測 (手順は ../BENCHMARK.md)
node bench/latency.mjs https://company-resolver.queria.io   # 手元から API の応答時間を計測
```

## デプロイ

Cloudflare の Workers Builds が、`main` に入った変更を `npx wrangler deploy` で本番（`queria-company-resolver`）にデプロイする。PR をマージすると本番に出る。`main` 以外のブランチへの push は `npx wrangler versions upload` で、本番に出さないバージョンだけを作る。どちらもルートは `worker/`。

正引きの索引（D1）は Worker のデプロイとは別に、`.github/workflows/sync.yml` の `d1` ジョブが反映する。D1 のテーブルを変える PR は、マージの前に `uv run python scripts/sync_d1.py` で D1 を新しい形にしておく（Worker のデプロイより先に表が入れ替わるので、変更前の Worker でも引ける形にする）。
