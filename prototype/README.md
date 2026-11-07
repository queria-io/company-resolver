# 試作

法人番号の全件から商号の索引を作り、EDINET の提出者を正解にして照合を測る。Worker と dbt に移す前の、規則と数字を確かめるための試作。

```bash
# 入力の Parquet は Queria の houjin_bangou.main.mart_houjin_bangou と edinet.main.mart_companies
python build_index.py houjin.parquet out/
python bench.py out/ edinet.parquet
```

- `normalize.sql`: 正規化（法人格の分離、空白・ハイフン類の除去、小書きの仮名を大きい仮名に揃える）と文字 bigram
- `build_index.py`: 法人ごとの正規化した商号と、bigram の索引（IDF つき）
- `bench.py`: 照合とベンチマーク。結果は [../BENCHMARK.md](../BENCHMARK.md)
