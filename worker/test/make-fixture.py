"""テスト用の小さな索引を test/fixture/ に作る。

usage (リポジトリの直下で): uv run python worker/test/make-fixture.py

本番と同じ dbt のモデルを、法人番号のデータセットの代わりに手元のカタログ (下の架空の法人) に向けて流す。
- 逆引き: Parquet と、そのファイルの一覧 test/fixture/manifest.json (Worker は目録から読む。src/source.ts)
- 正引き: 静的アセットに置くファイル test/fixture/assets/ (本番と同じく scripts/build-data.mjs が分けて置く)
法人は架空のもの。並びと規則を試すために、同じ商号を別の市区町村に置いている
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parents[2]

FIXTURE = Path(__file__).resolve().parent / "fixture"

COMPANIES = [
    ("1000000000001", "株式会社クエリア", "東京都", "千代田区", "131016"),
    ("1000000000002", "株式会社クエリア", "東京都", "府中市", "132063"),
    ("1000000000003", "株式会社クエリア", "広島県", "府中市", "342084"),
    ("1000000000004", "クエリア商事株式会社", "東京都", "千代田区", "131016"),
    ("1000000000005", "有限会社クエリア", "北海道", "札幌市中央区", "011011"),
    ("1000000000006", "株式会社キヤリアバンク", "東京都", "中央区", "131024"),
    ("1000000000007", "株式会社テスト工業", "東京都", "中央区", "131024"),
    ("1000000000008", "テスト工業株式会社", "大阪府", "大阪市北区", "271276"),
    # 国の機関と地方公共団体 (部局の名前を親の機関に照合する規則 parent_body を試す)
    ("1000000000101", "国土交通省", "東京都", "千代田区", "131016"),
    ("1000000000201", "茨城県", "茨城県", "水戸市", "082015"),
    ("1000000000202", "府中市", "東京都", "府中市", "132063"),
    ("1000000000203", "府中市", "広島県", "府中市", "342084"),
    ("1000000000204", "千代田区", "東京都", "千代田区", "131016"),
    # 先頭が地方公共団体の名前の会社 (部局の名前をこの会社に寄せない)
    ("1000000000011", "株式会社茨城県土浦花き市場", "茨城県", "土浦市", "082031"),
    # 前に法人の種類が付いた、先頭が地方公共団体の名前の法人と、部局の名前の後ろに続く名前の法人
    ("1000000000012", "公立大学法人茨城県立大学", "茨城県", "水戸市", "082015"),
    ("1000000000013", "茨城県土浦土木事務所職員会", "茨城県", "土浦市", "082031"),
    # 先頭が地方公共団体の名前の会社 (その支店の名前と、1 文字違いの誤字を親の機関に寄せない)
    ("1000000000014", "茨城県交通株式会社", "茨城県", "水戸市", "082015"),
    ("1000000000015", "府中市場運輸株式会社", "東京都", "府中市", "132063"),
]
# 法人種別。書いていない法人は 301 (株式会社)
KINDS = {"1000000000101": "101", "1000000000201": "201", "1000000000202": "201", "1000000000203": "201",
         "1000000000204": "201"}
FIRST = date(2015, 10, 5)
# 履歴。1000000000001 は所在地を 2 回変えた法人、1000000000009 は商号を変えたあと合併で閉鎖した法人
HISTORY = [
    (c[0], 1, c[0] != "1000000000001", FIRST, c[1], c[2], c[3], c[4], None, None, None) for c in COMPANIES
] + [
    ("1000000000001", 2, False, date(2020, 4, 1), "株式会社クエリア", "東京都", "中央区", "131024", None, None, None),
    ("1000000000001", 3, True, date(2022, 4, 1), "株式会社クエリア", "東京都", "千代田区", "131016", None, None, None),
    ("1000000000009", 1, False, FIRST, "クエリア工業株式会社", "東京都", "千代田区", "131016", None, None, None),
    ("1000000000009", 2, True, date(2023, 1, 1), "旧クエリア株式会社", "東京都", "千代田区", "131016",
     date(2023, 1, 1), "11", "1000000000001"),
]


def source(path: Path) -> None:
    """法人番号のデータセットと同じ名前・列のテーブルを、手元の DuckLake に作る"""
    con = duckdb.connect()
    con.execute(f"ATTACH 'ducklake:{path}/catalog.sqlite' AS h (DATA_PATH '{path}/data/', DATA_INLINING_ROW_LIMIT 0)")
    con.execute("""
        CREATE TABLE h.mart_houjin_bangou (corporate_number VARCHAR, name VARCHAR, furigana VARCHAR, kind VARCHAR,
            prefecture_name VARCHAR, city_name VARCHAR, street_number VARCHAR, lg_code VARCHAR, assignment_date DATE)
    """)
    con.executemany("INSERT INTO h.mart_houjin_bangou VALUES (?, ?, NULL, ?, ?, ?, '1-1', ?, ?)",
                    [(c[0], c[1], KINDS.get(c[0], "301"), *c[2:], FIRST) for c in COMPANIES])
    con.execute("""
        CREATE TABLE h.mart_houjin_bangou_history (corporate_number VARCHAR, history_seq BIGINT, is_latest BOOLEAN,
            change_date DATE, name VARCHAR, furigana VARCHAR, kind VARCHAR, prefecture_name VARCHAR, city_name VARCHAR,
            street_number VARCHAR, lg_code VARCHAR, assignment_date DATE, close_date DATE, close_cause VARCHAR,
            successor_corporate_number VARCHAR)
    """)
    con.executemany("""
        INSERT INTO h.mart_houjin_bangou_history
        VALUES (?, ?, ?, ?, ?, NULL, '301', ?, ?, CASE WHEN ? = '131024' THEN '2-2' ELSE '1-1' END, ?, ?, ?, ?, ?)
    """, [(*r[:7], r[7], r[7], FIRST, *r[8:]) for r in HISTORY])


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / "houjin").mkdir()
        source(tmp / "houjin")
        shutil.rmtree(FIXTURE, ignore_errors=True)
        env = {
            **os.environ,
            "HOUJIN_BANGOU": f"ducklake:{tmp}/houjin/catalog.sqlite",
            "FDL_WORKING": str(tmp / "work.sqlite"),
            "FDL_DATA_PATH": f"{FIXTURE}/",
        }
        # 共通の bigram (posting_common) の経路も試すよう、共通とみなす出現数を小さくする
        subprocess.run(
            ["dbt", "run", "--quiet", "--vars", '{"forward_national_rows": 2}'], cwd=ROOT, env=env, check=True
        )
        con = duckdb.connect()
        con.execute(f"ATTACH 'ducklake:sqlite:{tmp}/work.sqlite' AS c (READ_ONLY)")
        write_manifest(con)
        con.close()
        subprocess.run(
            ["node", "scripts/build-data.mjs", "--catalog", f"ducklake:sqlite:{tmp}/work.sqlite", str(FIXTURE / "assets")],
            cwd=ROOT / "worker", check=True,
        )
        # 正引きの表は assets/ に分けて置いたので、dbt が書いたファイルは残さない
        shutil.rmtree(FIXTURE / "forward")


def write_manifest(con: duckdb.DuckDBPyConnection) -> None:
    """逆引きの表のファイルの一覧 (FIXTURE からの相対パス) を書く"""
    rows = con.execute("SELECT data_file FROM ducklake_list_files('c', 'company', schema => 'reverse')").fetchall()
    paths = sorted(Path(f).resolve().relative_to(FIXTURE.resolve()).as_posix() for (f,) in rows)
    manifest = {"version": "local", "tables": {"reverse.company": paths}}
    (FIXTURE / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
