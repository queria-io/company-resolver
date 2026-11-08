"""scripts/sync_d1.py の差分の反映が、全件を入れ直した結果と一致することを確かめる"""

import sqlite3
import sys
import tempfile
from pathlib import Path

import duckdb
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import sync_d1  # noqa: E402

# 法人番号: (商号の本体, 法人格, lg_code)
OLD = {
    "1000000000001": ("クエリア", "株式会社", "131016"),
    "1000000000002": ("クエリア", "株式会社", "132063"),
    "1000000000003": ("テスト工業", "株式会社", "131024"),
    "1000000000004": ("キヤリアバンク", "株式会社", "131024"),
    "1000000000005": ("ア", None, "011011"),
}
NEW = {
    "1000000000001": ("クエリア", "株式会社", "131016"),
    "1000000000002": ("クエリア", "株式会社", "011011"),  # 移転
    "1000000000003": ("テスト工業所", "株式会社", "131024"),  # 改称
    # 1000000000004 は閉鎖
    "1000000000005": ("ア", None, "011011"),
    "1000000000006": ("クエリア商事", "合同会社", "131016"),  # 新設
}
CITIES = {
    "old": [("131016", "東京都", "千代田区"), ("132063", "東京都", "府中市"), ("131024", "東京都", "中央区")],
    "new": [("131016", "東京都", "千代田区"), ("131024", "東京都", "中央区"), ("011011", "北海道", "札幌市中央区")],
}


def bigrams(core: str) -> list[str]:
    return [core] if len(core) <= 1 else sorted({core[i : i + 2] for i in range(len(core) - 1)})


def make(con: duckdb.DuckDBPyConnection, alias: str, companies: dict, with_company_table: bool) -> None:
    """dbt の forward の表と同じ列の表を作る。with_company_table=False は forward.company_core の無い古い形"""
    con.execute(f"ATTACH ':memory:' AS {alias}")
    con.execute(f"CREATE SCHEMA {alias}.forward")
    rows = [(cn, core, lf, lg, f"{lf or ''}{core}") for cn, (core, lf, lg) in companies.items()]
    postings = [(g, lg, cn, lf, core, name) for cn, core, lf, lg, name in rows for g in bigrams(core)]
    if with_company_table:
        con.execute(f"CREATE TABLE {alias}.forward.company_core (corporate_number VARCHAR, core VARCHAR, "
                    "legal_form VARCHAR, lg_code VARCHAR, name VARCHAR)")
        con.executemany(f"INSERT INTO {alias}.forward.company_core VALUES (?, ?, ?, ?, ?)", rows)
        con.execute(f"CREATE TABLE {alias}.forward.posting (g VARCHAR, lg_code VARCHAR, corporate_number VARCHAR)")
        con.executemany(f"INSERT INTO {alias}.forward.posting VALUES (?, ?, ?)", [p[:3] for p in postings])
    else:
        con.execute(f"CREATE TABLE {alias}.forward.posting (g VARCHAR, lg_code VARCHAR, corporate_number VARCHAR, "
                    "legal_form VARCHAR, core VARCHAR, name VARCHAR)")
        con.executemany(f"INSERT INTO {alias}.forward.posting VALUES (?, ?, ?, ?, ?, ?)", postings)
    con.execute(f"""CREATE TABLE {alias}.forward.gram AS
        SELECT g, count(*) AS df, ln({len(companies)} / count(*)) AS idf FROM {alias}.forward.posting GROUP BY g""")
    con.execute(f"CREATE TABLE {alias}.forward.city (lg_code VARCHAR, prefecture_name VARCHAR, city_name VARCHAR)")
    con.executemany(f"INSERT INTO {alias}.forward.city VALUES (?, ?, ?)", CITIES[alias])


def apply(db: sqlite3.Connection, statements) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        for f in sync_d1.write_files(statements, Path(tmp)):
            db.executescript(f.read_text(encoding="utf-8"))


def dump(db: sqlite3.Connection) -> dict:
    return {t: sorted(db.execute(f"SELECT * FROM {t}").fetchall()) for t in ["company", "gram", "posting", "city"]}


@pytest.fixture(params=[True, False], ids=["same-format", "old-without-company-table"])
def con(request):
    c = duckdb.connect()
    make(c, "old", OLD, with_company_table=request.param)
    make(c, "new", NEW, with_company_table=True)
    return c


@pytest.fixture(autouse=True)
def small_batches(monkeypatch):
    """chunk と取り出しの区切りをまたぐように、小さくする"""
    monkeypatch.setattr(sync_d1, "CHUNK", 2)
    monkeypatch.setattr(sync_d1, "FETCH", 3)
    monkeypatch.setattr(sync_d1, "ROWS_PER_STATEMENT", 2)


def test_diff_matches_full(con):
    db = sqlite3.connect(":memory:")
    apply(db, sync_d1.full(con, "old"))
    sync_d1.prepare_diff(con, "old", "new")
    apply(db, sync_d1.diff(con, "new"))

    expected = sqlite3.connect(":memory:")
    apply(expected, sync_d1.full(con, "new"))
    assert dump(db) == dump(expected)


def test_diff_can_be_applied_twice(con):
    db = sqlite3.connect(":memory:")
    apply(db, sync_d1.full(con, "old"))
    sync_d1.prepare_diff(con, "old", "new")
    apply(db, sync_d1.diff(con, "new"))
    once = dump(db)
    apply(db, sync_d1.diff(con, "new"))
    assert dump(db) == once


def test_diff_writes_only_changed_companies(con):
    sync_d1.prepare_diff(con, "old", "new")
    sql = "\n".join(sync_d1.diff(con, "new"))
    assert "1000000000001" not in sql
    assert "1000000000004" in sql  # 閉鎖した法人を消す


def test_statements_fit_in_byte_limit(monkeypatch):
    """長い商号が続いても、1 文が BYTES_PER_STATEMENT を超えない"""
    monkeypatch.setattr(sync_d1, "ROWS_PER_STATEMENT", 500)
    monkeypatch.setattr(sync_d1, "BYTES_PER_STATEMENT", 1_000)
    rows = [(f"{i:013}", "長" * 50, "株式会社", "131016", "株式会社" + "長" * 50) for i in range(20)]
    statements = list(sync_d1.insert("company", rows))
    assert len(statements) > 1
    head = len("INSERT INTO company VALUES ".encode())
    assert all(len(s.encode()) - head <= 1_000 for s in statements)
    db = sqlite3.connect(":memory:")
    db.execute(sync_d1.SCHEMA[0])
    for s in statements:
        db.execute(s)
    assert db.execute("SELECT count(*) FROM company").fetchone()[0] == 20
