"""EDINET の提出者から、bench/run.ts に渡す問い合わせ (JSONL) を作る。

usage (リポジトリの直下で): uv run python worker/bench/make-queries.py <edinet.parquet> <out_dir> [<company_resolver の DuckLake>]
out_dir に clean.jsonl (正しい名前＋住所)、typo.jsonl (誤字あり＋住所)、bare.jsonl (法人格を外した名前＋住所)、bare-typo.jsonl (法人格を外した誤字あり＋住所)、
trunc1〜3.jsonl (法人格を外し、商号の本体の末尾を 1〜3 文字削った名前＋住所。削った後に 3 文字以上残る法人だけ) を書く。
company_resolver の DuckLake (例: ducklake:https://data.queria.io/datasets/queria/company_resolver/metadata.db) を渡すと、
former.jsonl (旧商号＋住所。forward.former_name の商号のうち、NFKC と空白の除去で今の提出者名と同じになるものを除く) も書く。
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
                    ELSE name END AS typo_name,
               CASE WHEN lf IS NULL THEN name ELSE trim(replace(name, lf, '')) END AS bare_name,
               CASE WHEN length(core) >= 3
                    THEN core[1:(CAST(truth AS BIGINT) % length(core))::int] || core[(CAST(truth AS BIGINT) % length(core))::int + 2:]
                    ELSE core END AS bare_typo_name
        FROM e
    """)


def write_former(con: duckdb.DuckDBPyConnection, catalog: str, out: str) -> None:
    con.execute(f"ATTACH '{catalog}' AS cr (READ_ONLY)")
    rows = con.execute("""
        SELECT truth, f.name, address FROM query JOIN cr.forward.former_name f ON f.corporate_number = query.truth
        WHERE replace(replace(f.name, ' ', ''), '　', '') <> replace(replace(query.name, ' ', ''), '　', '')
        ORDER BY qid, f.name
    """).fetchall()
    with open(Path(out) / "former.jsonl", "w") as f:
        for truth, name, address in rows:
            f.write(json.dumps({"truth": truth, "name": name, "address": address}, ensure_ascii=False) + "\n")


def main(edinet: str, out: str, catalog: str | None = None) -> None:
    con = duckdb.connect()
    load_queries(con, edinet)
    for label, col in (("clean", "name"), ("typo", "typo_name"), ("bare", "bare_name"), ("bare-typo", "bare_typo_name")):
        rows = con.execute(f"SELECT truth, {col}, address FROM query ORDER BY qid").fetchall()
        with open(Path(out) / f"{label}.jsonl", "w") as f:
            for truth, name, address in rows:
                f.write(json.dumps({"truth": truth, "name": name, "address": address}, ensure_ascii=False) + "\n")
    for k in (1, 2, 3):
        rows = con.execute(
            f"SELECT truth, core[1:length(core) - {k}], address FROM query WHERE length(core) >= {k} + 3 ORDER BY qid"
        ).fetchall()
        with open(Path(out) / f"trunc{k}.jsonl", "w") as f:
            for truth, name, address in rows:
                f.write(json.dumps({"truth": truth, "name": name, "address": address}, ensure_ascii=False) + "\n")
    if catalog:
        write_former(con, catalog, out)


if __name__ == "__main__":
    main(*sys.argv[1:4])
