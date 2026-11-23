"""法人ごとの旧商号を NFKC で正規化する。変更履歴の各行の商号と、商号の変更の行に記録された前の商号 (previous_name) を集める。
訂正の行 (correct = '1') で別の商号に直された商号は、誤って登録された商号なので除く。訂正の行の previous_name も使わない。
今の商号と同じものも残す (company_core が今の商号と比べて除く)。商号を変えたことのある法人だけを読む"""
import pyarrow.compute as pc


def model(dbt, session):
    t = session.sql("""
        WITH h AS (
            SELECT corporate_number, name, previous_name, process, correct,
                lead(correct) OVER w = '1' AND lead(name) OVER w IS DISTINCT FROM name AS corrected
            FROM houjin_bangou.main.mart_houjin_bangou_history
            WINDOW w AS (PARTITION BY corporate_number ORDER BY history_seq)
        ),
        n AS (
            SELECT corporate_number, name AS n FROM h WHERE NOT coalesce(corrected, false)
            UNION ALL
            SELECT corporate_number, previous_name FROM h WHERE process = '11' AND correct = '0'
        ),
        renamed AS (
            SELECT corporate_number FROM n WHERE coalesce(n, '') <> ''
            GROUP BY corporate_number HAVING count(DISTINCT n) > 1
        )
        SELECT DISTINCT corporate_number, n AS name
        FROM n JOIN renamed USING (corporate_number)
        WHERE coalesce(n, '') <> ''
        ORDER BY corporate_number, name
    """).to_arrow_table()
    return t.set_column(t.schema.get_field_index("name"), "name", pc.utf8_normalize(t["name"], "NFKC"))
