"""build_index.py の索引を、Worker が R2 から読む Parquet に書き出す（試作）。

usage: python export_parquet.py <index_dir> <out_dir>

- posting/shard=NNNN.parquet: bigram ごとの法人（g, lg_code の順）。行グループは 1,024 行
- gram/shard=NNNN.parquet: bigram ごとの出現する法人の数（df）と IDF。Worker はファイルを丸ごと読む
- city.parquet: 市区町村の lg_code・都道府県名・市区町村名

shard は bigram の文字のコードポイントの和を SHARDS で割った余り。1 件の検索で開くファイルを
bigram の数までに抑え、各ファイルのフッターを小さく保つために分ける
"""
import sys
from pathlib import Path

import pyarrow.parquet as pq

from build_index import connect

SHARDS = 1024
ROW_GROUP_ROWS = 1024


def export(index_dir: str, out: str) -> None:
    con = connect(f"{index_dir}/index.duckdb")
    con.execute(f"""
        CREATE OR REPLACE MACRO shard(g) AS
          list_sum([unicode(substr(g, i, 1)) FOR i IN range(1, length(g) + 1)]) % {SHARDS}
    """)
    for sub in ("posting", "gram"):
        (Path(out) / sub).mkdir(parents=True, exist_ok=True)
    con.execute("""
        CREATE OR REPLACE TEMP TABLE posting AS
        SELECT shard(g.g) AS shard, g.g, g.lg_code, g.corporate_number, c.legal_form, c.core, c.name
        FROM gram g JOIN company c USING (corporate_number)
    """)
    con.execute("CREATE OR REPLACE TEMP TABLE gram_shard AS SELECT shard(g) AS shard, g, df, idf FROM gram_idf")
    # 行の無い番号のファイルは作らない (Worker はファイルが無ければその番号の bigram は無いとみなす)
    for (k,) in con.execute("SELECT DISTINCT shard FROM gram_shard ORDER BY shard").fetchall():
        rows = con.execute(f"""
            SELECT g, lg_code, corporate_number, legal_form, core, name FROM posting
            WHERE shard = {k} ORDER BY g, lg_code, corporate_number
        """).to_arrow_table()
        # 統計は行グループを選ぶ g と lg_code だけに付ける (フッターを小さく保ち、1 回の読みで取れるように)
        pq.write_table(rows, f"{out}/posting/shard={k:04d}.parquet", row_group_size=ROW_GROUP_ROWS,
                       compression="zstd", write_statistics=["g", "lg_code"])
        con.execute(f"""
            COPY (SELECT g, df, idf FROM gram_shard WHERE shard = {k} ORDER BY g)
            TO '{out}/gram/shard={k:04d}.parquet' (FORMAT parquet, COMPRESSION zstd)
        """)
    con.execute(f"""
        COPY (
          SELECT DISTINCT lg_code, prefecture_name, city_name FROM company WHERE city_name <> '' ORDER BY lg_code
        ) TO '{out}/city.parquet' (FORMAT parquet, COMPRESSION zstd)
    """)


if __name__ == "__main__":
    export(sys.argv[1], sys.argv[2])
