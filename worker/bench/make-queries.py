"""EDINET の提出者から、bench/run.ts に渡す問い合わせ (JSONL) を作る。

usage (リポジトリの直下で): uv run python worker/bench/make-queries.py <edinet.parquet> <out_dir>
out_dir に clean.jsonl (正しい名前＋住所) と typo.jsonl (誤字あり＋住所) を書く。
正規化の規則は dbt のマクロ (macros/normalize.sql) をそのまま使う
"""
import json
import sys
from pathlib import Path

import duckdb
import jinja2
import pyarrow.compute as pc

MACROS = jinja2.Template((Path(__file__).resolve().parents[2] / "macros" / "normalize.sql").read_text()).module


def load_queries(con: duckdb.DuckDBPyConnection, edinet: str) -> None:
    raw = con.read_parquet(edinet).to_arrow_table()
    i = raw.schema.get_field_index("filer_name")
    con.register("edinet_raw", raw.set_column(i, "filer_name", pc.utf8_normalize(raw["filer_name"], "NFKC")))
    # typo_name: 法人格を「(株)」などに略し、商号の本体から 1 文字を消す（位置は法人番号を商号の文字数で割った余り）
    con.execute(f"""
        CREATE OR REPLACE TABLE query AS
        WITH e AS (
          SELECT corporate_number AS truth, filer_name AS name, address,
                 {MACROS.legal_form('filer_name')} AS lf, {MACROS.core_name('filer_name')} AS core
          FROM edinet_raw
          WHERE submitter_type = '内国法人・組合' AND length(corporate_number) = 13
        )
        SELECT row_number() OVER () AS qid, truth, name, address, lf, core,
               CASE WHEN length(core) >= 3
                    THEN coalesce(replace(replace(replace(lf, '株式会社', '(株)'), '有限会社', '(有)'), '合同会社', '(同)'), '')
                         || core[1:(CAST(truth AS BIGINT) % length(core))::int] || core[(CAST(truth AS BIGINT) % length(core))::int + 2:]
                    ELSE name END AS typo_name
        FROM e
    """)


def main(edinet: str, out: str) -> None:
    con = duckdb.connect()
    load_queries(con, edinet)
    for label, col in (("clean", "name"), ("typo", "typo_name")):
        rows = con.execute(f"SELECT truth, {col}, address FROM query ORDER BY qid").fetchall()
        with open(Path(out) / f"{label}.jsonl", "w") as f:
            for truth, name, address in rows:
                f.write(json.dumps({"truth": truth, "name": name, "address": address}, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
