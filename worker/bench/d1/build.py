"""正引きの索引を D1 (SQLite) に入れる形にする。D1 と R2 の比較の計測用 (bench/d1/README.md)

usage: uv run python worker/bench/d1/build.py <索引の目録 manifest.json か DuckLake の URL> <出力先>
  出力: index.sqlite (手元のベンチマーク用)、city.json (Worker に同梱する市区町村の一覧)、
        sql/NNN.sql (wrangler d1 execute --file で流す。1 ファイル 1 GB 未満)
"""

import json
import sqlite3
import sys
from pathlib import Path

import duckdb

SCHEMA = """
CREATE TABLE company (corporate_number TEXT PRIMARY KEY, core TEXT NOT NULL, legal_form TEXT,
  lg_code TEXT, name TEXT) WITHOUT ROWID;
CREATE TABLE gram (g TEXT PRIMARY KEY, df INTEGER NOT NULL, idf REAL NOT NULL) WITHOUT ROWID;
CREATE TABLE posting (g TEXT NOT NULL, lg_code TEXT NOT NULL, corporate_number TEXT NOT NULL,
  PRIMARY KEY (g, lg_code, corporate_number)) WITHOUT ROWID;
"""
INDEXES = "CREATE INDEX company_core ON company (core);"
ROWS_PER_INSERT = 500
BYTES_PER_FILE = 900 * 2**20


def source(con: duckdb.DuckDBPyConnection, src: str) -> dict[str, str]:
    """テーブル名 → DuckDB で読む式"""
    if src.endswith(".json"):
        root = Path(src).parent
        tables = json.loads(Path(src).read_text())["tables"]
        return {
            t: "read_parquet([" + ",".join(f"'{root / p}'" for p in tables[f"forward.{t}"]) + "])"
            for t in ["posting", "gram", "city"]
        }
    con.execute(f"ATTACH 'ducklake:{src}' AS cr (READ_ONLY)")
    return {t: f"cr.forward.{t}" for t in ["posting", "gram", "city"]}


QUERIES = {
    "company": "SELECT DISTINCT corporate_number, core, legal_form, lg_code, name FROM {posting} ORDER BY 1",
    "gram": "SELECT g, df, idf FROM {gram} ORDER BY g",
    "posting": "SELECT g, coalesce(lg_code, ''), corporate_number FROM {posting} ORDER BY g, lg_code, corporate_number",
}


def main(src: str, out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute("INSTALL ducklake; LOAD ducklake; SET preserve_insertion_order = true")
    tables = source(con, src)
    cities = con.execute(
        f"SELECT lg_code, prefecture_name, city_name FROM {tables['city']} ORDER BY lg_code"
    ).fetchall()
    (out / "city.json").write_text(
        json.dumps(
            [dict(lg_code=a, prefecture_name=b, city_name=c) for a, b, c in cities],
            ensure_ascii=False,
        )
    )

    db_path = out / "index.sqlite"
    db_path.unlink(missing_ok=True)
    db = sqlite3.connect(db_path)
    db.executescript(SCHEMA)
    for table, query in QUERIES.items():
        cur = con.execute(query.format(**tables))
        while batch := cur.fetchmany(100_000):
            marks = ",".join("?" * len(batch[0]))
            db.executemany(f"INSERT INTO {table} VALUES ({marks})", batch)
        db.commit()
        print(table, db.execute(f"SELECT count(*) FROM {table}").fetchone()[0], flush=True)
    db.executescript(INDEXES)
    db.commit()
    write_sql(db, out / "sql")


def literal(v: object) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def write_sql(db: sqlite3.Connection, dir: Path) -> None:
    """D1 に流す SQL。BEGIN / COMMIT は D1 が受け付けないので書かない。索引は行を入れた後に作る"""
    dir.mkdir(exist_ok=True)
    for f in dir.glob("*.sql"):
        f.unlink()
    files = (dir / f"{i:03}.sql" for i in range(1000))
    f = next(files).open("w")
    f.write(SCHEMA)
    for table in QUERIES:
        cur = db.execute(f"SELECT * FROM {table}")
        while rows := cur.fetchmany(ROWS_PER_INSERT):
            if f.tell() > BYTES_PER_FILE:
                f.close()
                f = next(files).open("w")
            values = ",".join("(" + ",".join(map(literal, r)) + ")" for r in rows)
            f.write(f"INSERT INTO {table} VALUES {values};\n")
    f.write(INDEXES + "\n")
    f.close()


if __name__ == "__main__":
    main(sys.argv[1], Path(sys.argv[2]))
