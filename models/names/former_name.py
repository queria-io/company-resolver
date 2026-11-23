"""法人ごとの旧商号を NFKC で正規化する。変更履歴の各行の商号と、変更の行に記録された前の商号 (previous_name) を集める。
今の商号と同じものも残す (company_core が今の商号と比べて除く)。商号を変えたことのある法人だけを読む"""
import pyarrow.compute as pc


def model(dbt, session):
    t = session.sql("""
        WITH h AS (SELECT corporate_number, name, previous_name FROM houjin_bangou.main.mart_houjin_bangou_history),
        renamed AS (
            SELECT corporate_number FROM h
            GROUP BY corporate_number
            HAVING count(DISTINCT name) > 1 OR bool_or(coalesce(previous_name, '') <> '')
        )
        SELECT DISTINCT corporate_number, n AS name
        FROM (SELECT corporate_number, name AS n FROM h UNION ALL SELECT corporate_number, previous_name FROM h)
        JOIN renamed USING (corporate_number)
        WHERE coalesce(n, '') <> ''
        ORDER BY corporate_number, name
    """).to_arrow_table()
    return t.set_column(t.schema.get_field_index("name"), "name", pc.utf8_normalize(t["name"], "NFKC"))
