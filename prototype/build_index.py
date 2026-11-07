"""法人番号の全件から、商号の bigram 索引を作る（試作）。

usage: python -I build_index.py <houjin.parquet> <out_dir>
"""
import sys
from pathlib import Path

import duckdb
import pyarrow.compute as pc

HERE = Path(__file__).parent


def connect(db: str) -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(db)
    con.execute((HERE / "normalize.sql").read_text())
    return con


def nfkc(table):
    return table.set_column(
        table.schema.get_field_index("name"), "name", pc.utf8_normalize(table["name"], "NFKC")
    )


def build(src: str, out: str) -> None:
    con = connect(f"{out}/index.duckdb")
    houjin = nfkc(con.read_parquet(src).to_arrow_table())
    con.register("houjin_raw", houjin)
    con.execute("""
        CREATE OR REPLACE TABLE company AS
        SELECT corporate_number, name, furigana, kind, prefecture_name, city_name, street_number, lg_code,
               legal_form(name) AS legal_form, core_name(name) AS core
        FROM houjin_raw
    """)
    con.execute("""
        CREATE OR REPLACE TABLE gram AS
        SELECT unnest(bigrams(core)) AS g, corporate_number, lg_code FROM company WHERE core <> ''
    """)
    con.execute("""
        CREATE OR REPLACE TABLE gram_idf AS
        SELECT g, count(*) AS df, ln((SELECT count(*) FROM company) / count(*)) AS idf
        FROM gram GROUP BY g
    """)
    print(con.sql("SELECT (SELECT count(*) FROM company) companies, (SELECT count(*) FROM gram) postings, (SELECT count(*) FROM gram_idf) grams").fetchall())


if __name__ == "__main__":
    build(sys.argv[1], sys.argv[2])
