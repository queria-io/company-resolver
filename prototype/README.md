# 索引の作成

法人番号の全件から商号の索引を作り、Worker が R2 から読む Parquet に書き出す。のちに dbt のデータセットに移す。

```bash
# 入力の Parquet は Queria の houjin_bangou.main.mart_houjin_bangou
python build_index.py houjin.parquet out/
python export_parquet.py out/ index/
# 逆引き。入力は houjin_bangou.main.mart_houjin_bangou_history
python export_company.py history.parquet index/
```

- `normalize.sql`: 正規化（法人格の分離、空白・ハイフン類の除去、小書きの仮名を大きい仮名に揃える）と文字 bigram。Worker の `src/normalize.ts` と同じ規則
- `build_index.py`: 法人ごとの正規化した商号と、bigram の索引（IDF つき）を DuckDB に作る
- `export_company.py`: 逆引き用に、法人ごとの最新の状態と旧商号・旧所在地を書き出す
- `export_parquet.py`: Worker が読む Parquet に書き出す。形は [../worker/README.md](../worker/README.md)

照合とベンチマークは Worker 側にある（[../BENCHMARK.md](../BENCHMARK.md)）。
