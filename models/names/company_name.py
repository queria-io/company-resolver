"""法人ごとの商号を NFKC で正規化する。DuckDB に NFKC の関数が無いので、ここだけ Python で書く"""
import pyarrow.compute as pc


def model(dbt, session):
    t = session.sql("""
        SELECT corporate_number, name, prefecture_name, city_name, lg_code
        FROM houjin_bangou.main.mart_houjin_bangou
    """).to_arrow_table()
    return t.set_column(t.schema.get_field_index("name"), "name", pc.utf8_normalize(t["name"], "NFKC"))
