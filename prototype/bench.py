"""EDINET の提出者（法人番号つき）を正解にして照合を測る（試作）。

usage: python -I bench.py <index_dir> <edinet.parquet>
"""
import sys

import pyarrow.compute as pc

from build_index import connect

# 1 件の検索で引く bigram の数。珍しい順に取る（読む索引の量を抑えるため）
RAREST_GRAMS = 8
# 編集距離で比べる候補の数
COMPARE_TOP = 100

VARIANTS = {
    "clean": ("name", "address"),
    "typo": ("typo_name", "address"),
}


def load_queries(con, edinet: str) -> None:
    t = con.read_parquet(edinet).to_arrow_table()
    t = t.set_column(t.schema.get_field_index("filer_name"), "filer_name", pc.utf8_normalize(t["filer_name"], "NFKC"))
    con.register("edinet_raw", t)
    # typo_name: 法人格を「(株)」などに略し、商号の本体から 1 文字を消す（位置は法人番号から決める）
    con.execute("""
        CREATE OR REPLACE TABLE query AS
        WITH e AS (
          SELECT corporate_number AS truth, filer_name AS name, address,
                 legal_form(filer_name) AS lf, core_name(filer_name) AS core
          FROM edinet_raw
          WHERE submitter_type = '内国法人・組合' AND length(corporate_number) = 13
        )
        SELECT row_number() OVER () AS qid, truth, name, address, lf, core,
               CASE WHEN length(core) >= 3
                    THEN coalesce(replace(replace(replace(lf, '株式会社', '(株)'), '有限会社', '(有)'), '合同会社', '(同)'), '')
                         || core[1:(hash(truth) % length(core))::int] || core[(hash(truth) % length(core))::int + 2:]
                    ELSE name END AS typo_name
        FROM e
    """)


def run(con, name_col: str, addr_col: str | None) -> dict:
    addr = addr_col or "NULL::VARCHAR"
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE q AS
        SELECT qid, truth, legal_form({name_col}) AS lf, core_name({name_col}) AS core, {addr} AS address FROM query
    """)
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE qg AS
        SELECT qid, g, idf FROM (SELECT qid, unnest(bigrams(core)) AS g FROM q) JOIN gram_idf USING (g)
        QUALIFY row_number() OVER (PARTITION BY qid ORDER BY df) <= {RAREST_GRAMS}
    """)
    # 住所に含まれる市区町村名のうち最も長いもの（「札幌市中央区」を「中央区」より優先）
    con.execute("""
        CREATE OR REPLACE TEMP TABLE q_city_tbl AS
        SELECT q.qid, c.lg_code, c.city_name
        FROM q JOIN (SELECT DISTINCT lg_code, city_name FROM company WHERE city_name <> '') c
          ON contains(q.address, c.city_name)
        QUALIFY length(c.city_name) = max(length(c.city_name)) OVER (PARTITION BY q.qid)
    """)
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE hit AS
        SELECT qid, corporate_number, sum(idf) AS score
        FROM qg JOIN gram USING (g) GROUP BY qid, corporate_number
        QUALIFY row_number() OVER (PARTITION BY qid ORDER BY score DESC, corporate_number) <= {COMPARE_TOP}
    """)
    # 住所の市区町村の中だけで引いた上位も足す（索引を地域で分けて読む形に当たる）
    con.execute(f"""
        INSERT INTO hit
        WITH q_city AS (SELECT qid, lg_code FROM q_city_tbl)
        SELECT qg.qid, gram.corporate_number, sum(qg.idf) AS score
        FROM qg JOIN q_city USING (qid) JOIN gram ON gram.g = qg.g AND gram.lg_code = q_city.lg_code
        GROUP BY qg.qid, gram.corporate_number
        QUALIFY row_number() OVER (PARTITION BY qg.qid ORDER BY score DESC, gram.corporate_number) <= {COMPARE_TOP}
    """)
    con.execute("""
        CREATE OR REPLACE TEMP TABLE cand AS
        SELECT DISTINCT h.qid, q.truth, c.corporate_number, h.score,
               levenshtein(q.core, c.core) AS ed,
               (q.lf IS NULL OR q.lf = c.legal_form) AS legal_ok,
               c.lg_code IN (SELECT lg_code FROM q_city_tbl t WHERE t.qid = h.qid) AS city_ok
        FROM (SELECT qid, corporate_number, max(score) AS score FROM hit GROUP BY ALL) h
        JOIN q USING (qid) JOIN company c USING (corporate_number)
    """)
    # 商号が完全一致する法人の総数（上位 100 件の外も数える）
    con.execute("""
        CREATE OR REPLACE TEMP TABLE same AS
        SELECT q.qid,
               count(c.corporate_number) FILTER (WHERE q.lf IS NULL OR q.lf = c.legal_form) AS same_name,
               count(c.corporate_number) FILTER (WHERE (q.lf IS NULL OR q.lf = c.legal_form)
                     AND c.lg_code IN (SELECT lg_code FROM q_city_tbl t WHERE t.qid = q.qid)) AS same_name_city
        FROM q LEFT JOIN company c ON c.core = q.core GROUP BY q.qid
    """)
    return con.sql(f"""
        WITH ranked AS (
          SELECT *, row_number() OVER (PARTITION BY qid ORDER BY ed, city_ok DESC, legal_ok DESC, score DESC, corporate_number) AS rk,
                 row_number() OVER (PARTITION BY qid ORDER BY ed + 2 * (NOT city_ok)::int, ed, legal_ok DESC, score DESC, corporate_number) AS rk2
          FROM cand
        ),
        top AS (SELECT * FROM ranked WHERE rk = 1),
        res AS (
          SELECT q.qid, q.truth,
                 bool_or(r.corporate_number = q.truth AND r.rk = 1) AS top1,
                 bool_or(r.corporate_number = q.truth AND r.rk <= 5) AS top5,
                 bool_or(r.corporate_number = q.truth AND r.rk2 = 1) AS top1_main,
                 bool_or(r.corporate_number = q.truth AND r.rk2 <= 5) AS top5_main,
                 any_value(s.same_name) AS same_name, any_value(s.same_name_city) AS same_name_city
          FROM q LEFT JOIN ranked r USING (qid) LEFT JOIN same s USING (qid) GROUP BY ALL
        ),
        m AS (
          SELECT res.*, t.corporate_number AS top_cn,
                 (t.ed = 0 AND t.legal_ok AND
                  CASE WHEN {'TRUE' if addr_col else 'FALSE'} THEN t.city_ok AND same_name_city = 1 ELSE same_name = 1 END) AS matched
          FROM res LEFT JOIN top t USING (qid)
        )
        SELECT (SELECT list(struct_pack(truth := m2.truth, top := m2.top_cn)) FROM (SELECT * FROM m WHERE matched AND top_cn <> truth LIMIT 30) m2) AS wrong,
               count(*) AS n,
               count(*) FILTER (WHERE qid IN (SELECT qid FROM cand WHERE corporate_number = truth)) AS in_compare,
               count(*) FILTER (WHERE top1_main) AS top1_main,
               count(*) FILTER (WHERE top5_main) AS top5_main,
               count(*) FILTER (WHERE truth IN (SELECT corporate_number FROM company)) AS truth_exists,
               count(*) FILTER (WHERE top1) AS top1, count(*) FILTER (WHERE top5) AS top5,
               count(*) FILTER (WHERE matched) AS matched,
               count(*) FILTER (WHERE matched AND top_cn = truth) AS matched_correct
        FROM m
    """).fetchone()


def main(index_dir: str, edinet: str) -> None:
    con = connect(f"{index_dir}/index.duckdb")
    load_queries(con, edinet)
    print("variant\tn\tin_compare\ttop1\ttop5\ttruth_exists\ttop1_ed_first\ttop5_ed_first\tmatched\tmatched_correct")
    for label, (name_col, addr_col) in VARIANTS.items():
        wrong, *row = run(con, name_col, addr_col)
        print(label, *row, sep="\t", flush=True)
        con.execute(f"CREATE OR REPLACE TABLE wrong_{label} AS SELECT unnest(?, recursive := true)", [wrong])


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
