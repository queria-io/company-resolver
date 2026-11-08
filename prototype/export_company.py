"""法人番号の履歴から、Worker の逆引き (/v1/reverse) が読む Parquet を書き出す（試作）。

usage: python -I export_company.py <history.parquet> <out_dir>

入力は Queria の houjin_bangou.main.mart_houjin_bangou_history。閉鎖した法人も含める。

- company/shard=NNN.parquet: 法人ごとの最新の状態と、旧商号・旧所在地の一覧。NNN は法人番号の下 3 桁。
  法人番号の順に並べ、行グループは 2,048 行。統計は corporate_number だけに付ける
"""
import sys
from pathlib import Path

import duckdb
import pyarrow.parquet as pq

ROW_GROUP_ROWS = 2048

# 前の行と比べて、商号が変わった行の前の商号と、所在地が変わった行の前の所在地を、変わった日とともに集める
COMPANY_SQL = """
WITH h AS (
  SELECT *,
    lag(name) OVER w AS prev_name,
    lag(prefecture_name) OVER w AS prev_prefecture,
    lag(city_name) OVER w AS prev_city,
    lag(street_number) OVER w AS prev_street_number,
    lag(lg_code) OVER w AS prev_lg_code
  FROM read_parquet(?)
  WINDOW w AS (PARTITION BY corporate_number ORDER BY history_seq)
),
former_names AS (
  SELECT corporate_number, list({'name': prev_name, 'until': change_date} ORDER BY history_seq) AS former_names
  FROM h WHERE prev_name IS NOT NULL AND prev_name <> name
  GROUP BY corporate_number
),
former_addresses AS (
  SELECT corporate_number, list({
    'prefecture': prev_prefecture, 'city': prev_city, 'street_number': prev_street_number,
    'lg_code': prev_lg_code, 'until': change_date
  } ORDER BY history_seq) AS former_addresses
  FROM h
  WHERE history_seq > 1
    AND (prev_prefecture, prev_city, prev_street_number) IS DISTINCT FROM (prefecture_name, city_name, street_number)
  GROUP BY corporate_number
)
SELECT corporate_number, name, furigana, kind, prefecture_name, city_name, street_number, lg_code, assignment_date,
  close_date, close_cause, successor_corporate_number, former_names, former_addresses
FROM h LEFT JOIN former_names USING (corporate_number) LEFT JOIN former_addresses USING (corporate_number)
WHERE is_latest
"""


def export(src: str, out: str) -> None:
    con = duckdb.connect()
    # 1 回の問い合わせで法人番号の下 3 桁ごとに並べ、切り分けて書く
    rows = con.execute(
        f"SELECT right(corporate_number, 3) AS shard, * FROM ({COMPANY_SQL}) ORDER BY shard, corporate_number", [src]
    ).to_arrow_table()
    (Path(out) / "company").mkdir(parents=True, exist_ok=True)
    shards = rows.column("shard").to_pylist()
    rows = rows.drop_columns("shard")
    # 法人番号の下 3 桁は散らばるので、ファイルの大きさがほぼ揃う
    start = 0
    for end in range(1, len(shards) + 1):
        if end == len(shards) or shards[end] != shards[start]:
            pq.write_table(rows.slice(start, end - start), f"{out}/company/shard={shards[start]}.parquet",
                           row_group_size=ROW_GROUP_ROWS, compression="zstd", write_statistics=["corporate_number"])
            start = end

if __name__ == "__main__":
    export(sys.argv[1], sys.argv[2])
