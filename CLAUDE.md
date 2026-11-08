# CLAUDE.md

Queria Company Resolver（法人名寄せツール）。企業名・住所・電話番号・URL から法人番号を照合する。照合の規則と応答の形は [DESIGN.md](DESIGN.md) が正。

- 直下: Worker が読む索引を作る dbt のデータセット（Queria の `company_resolver`）。法人番号のデータセットを読み、毎月 `.github/workflows/sync.yml` が作り直す（`scripts/build.sh` で dbt を流して fdl commit）。続けて `scripts/sync_d1.py` が正引きの表を D1 に反映する
- `worker/`: Cloudflare Workers の API。正引きは D1 を引く。逆引きは DuckLake のカタログを読まず、FDL の `refs/heads/main` が指すバージョンの Parquet を直接読む
- D1 のテーブル（`scripts/sync_d1.py` の `SCHEMA`）と `worker/src/forward.ts` の SQL、逆引きの Parquet の列・並び・行グループ・ファイルの分け方と `worker/src/reverse.ts` の読み方は、片方だけ変えない。商号の正規化は `macros/normalize.sql` と `worker/src/normalize.ts` を同じ規則に保つ
- テーブルは毎回まるごと作り直す（incremental にすると削除ファイルができ、Parquet だけを読む Worker が消した行を返す）
- 改修では DESIGN.md の観点（精度・処理速度とメモリ使用量・データモデル・説明可能性）で影響を確認し、PR に記載する
- 公的データだけを使う。個人の情報（代表者名、個人事業主の電話番号など）は持たない
- PR 本文には変更内容と検証方法を書く
- 文書は技術文書として一般的な用語で書く（照合・比較方法・評価指標・正規化 など）
- `main` への直接コミットはしない。PR にして出し、マージは人間が行う。コミットメッセージは Conventional Commits
