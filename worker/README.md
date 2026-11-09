# Worker

法人名寄せ API（https://company-resolver.queria.io）。Cloudflare Workers で動く。正引きの索引は Worker と一緒にデプロイする静的アセットに、逆引きの索引は Parquet で R2 に置く（どちらも Queria のデータセットから作る）。照合の規則は [../DESIGN.md](../DESIGN.md)。

正引きは企業名（と住所）から法人番号の候補を返す。

```
GET /v1/forward?name=株式会社クエリア&address=東京都千代田区紀尾井町1-3&limit=5
```

`name` と `address` は 200 文字まで。応答は `status`（`matched` / `ambiguous` / `candidates` / `not_found`）、`same_name_count`、`candidates`（法人番号・商号・都道府県・市区町村・`evidence`）。ヘッダーの `X-Data-Version` はデプロイした索引のバージョン（データセットのバージョンの ID）、`X-Asset-Reads`・`X-Asset-Bytes` はその問い合わせで読んだ索引のファイルの数とバイト数。

複数の企業をまとめて照合するときは、1 回に 20 件までを `POST /v1/forward/batch` に渡す。応答の `results` は、`queries` と同じ順に、1 件ずつの正引きと同じ形の応答を並べたもの。IP ごとに 1 分 10 回まで（`BATCH_LIMITER`）。

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

### 正引き（静的アセット）

`pnpm build:data`（`scripts/build-data.mjs`）が、FDL の `refs/heads/main` が指すバージョンの `forward` の表を DuckDB で読み、`shard` などの列でファイルに分けて `public/data/` に置き、Worker と一緒にデプロイする。静的アセットはファイルを丸ごとしか読めないので、1 件の検索で読むファイルを小さくするために分ける。dbt の表は分けずに書く（毎月の Sync で上げるファイルを少なくする）。置き場所は列の値で決まる（Worker は目録を読まずにパスを組み立てる）。分ける数は `../dbt_project.yml` の `vars` と `src/forward.ts` で揃える。

| 表 | 置き場所 | 中身 |
|---|---|---|
| `exact_name` | `data/exact_name/{shard}.parquet` | 商号の本体ごとの法人（商号・法人格・lg_code）。商号の本体のコードポイントの和を 8,192 で割った余り |
| `gram` | `data/gram/{shard}.parquet` | bigram ごとの出現する法人の数（df）・IDF・共通の bigram の番号（`common_id`）。1,024 個 |
| `posting_rare` | `data/posting_rare/{shard}.parquet` | 出現する法人が 10,000 以下の bigram ごとの法人（商号・法人格・lg_code つき）。8,192 個 |
| `posting_common` | `data/posting_common/{common_id}/{bucket}.parquet` | 出現する法人が 10,000 を超える bigram ごとの法人。`bucket` は lg_code を 64 で割った余り |
| `city` | `data/city.parquet` | 市区町村の lg_code・都道府県名・市区町村名。Worker は isolate の中で 1 回だけ読む |
| `public_body` | `data/public_body.parquet` | 国の機関と地方公共団体（法人種別 101・201）。部局の名前を親の機関に照合するのに使う。isolate の中で 1 回だけ読む |

正引きは、まず `exact_name` のファイルを 1 つ読み、商号と法人格（住所があれば市区町村も）が一致する法人が 1 件だけなら答える。決まらないときだけ、入力の bigram の `gram` のファイルを読んで出現する法人が少ない 8 個を選び、出現する法人の合計が 10,000 に収まる bigram は `posting_rare` のファイルで全国の行を、残りは住所の市区町村の行だけを読む（共通の bigram は市区町村の区分のファイル）。共通の bigram を全国で読むと 1 件で数十万行になり、Worker のメモリに収まらないので読まない。商号が同じ法人は `exact_name` の行を全国の候補に加える。まとめて照合するときは、商号が同じ法人の表と bigram の出現数のファイルを 1 回だけ読み、近い商号の検索は 1 件ずつ進める。

データセットの main が進んだら、Worker をビルドし直してデプロイする（下のデプロイ）。

### 逆引き（R2）

Worker は DuckLake のカタログを読まず、FDL の `refs/heads/main` が指すバージョンの `files.json` から、`reverse.company` の Parquet を引いて直接読む（`src/source.ts`）。置き場は `wrangler.jsonc` の `DATA_SOURCE`。`shard`（法人番号の下 3 桁）ごとにファイルを分け、法人番号の順に並べ、行グループは 2,048 行。逆引きは `company` のフッターと行グループの 2 回読む。

## コマンド

```bash
pnpm build:data  # 正引きの索引を public/data/ に置く (データセットの main から)
pnpm test        # vitest (Workers ランタイム)。索引は test/fixture/ (リポジトリの直下で uv run python worker/test/make-fixture.py)。正引きは test/fixture/assets/ を静的アセットとして読む
pnpm typecheck
pnpm check       # oxlint + oxfmt --check
pnpm tsx bench/run.ts <queries.jsonl>   # 手元の public/data/ で正解率と読んだファイル・処理時間を計測 (手順は ../BENCHMARK.md)
pnpm tsx bench/ablate.ts <queries.jsonl>...   # 照合の規則を 1 つずつ外して、精度の変わり方を計測 (規則は ../DESIGN.md)
node bench/latency.mjs https://company-resolver.queria.io   # 手元から API の応答時間を計測
```

## デプロイ

Cloudflare の Workers Builds が、`main` に入った変更を、ビルドのコマンド `pnpm build:data` で正引きの索引を置いてから `npx wrangler deploy` で本番（`queria-company-resolver`）にデプロイする。PR をマージすると本番に出る。`main` 以外のブランチへの push は `npx wrangler versions upload` で、本番に出さないバージョン（プレビューの URL）だけを作る。どちらもルートは `worker/`。

データセットの main が進んだとき（毎月の Sync）は、`.github/workflows/sync.yml` の `deploy` ジョブが Workers Builds の deploy hook（シークレット `WORKERS_DEPLOY_HOOK_URL`）を呼び、main をビルドし直してデプロイする。
