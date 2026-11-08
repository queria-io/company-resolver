"""正引きの索引 (forward.posting・forward.gram・forward.city) を D1 に反映する。

usage (リポジトリの直下で):
  uv run python scripts/sync_d1.py                 # D1 (worker/wrangler.jsonc の DB) に反映する
  uv run python scripts/sync_d1.py --full          # 全件を入れ直す
  uv run python scripts/sync_d1.py --sqlite FILE   # D1 の代わりに手元の SQLite に反映する (ベンチマーク用)

読む元は FDL の refs/heads/main が指すバージョン。D1 の meta に最後に反映したバージョンがあり、そのカタログを
読めれば、2 つのバージョンを比べて変わった行だけを書く。meta が無いとき・前のカタログを読めないとき・--full の
ときは、テーブルを作り直して全件を入れる (そのあいだ正引きは失敗する)。
反映したら法人数と posting の行数を元データと照合し、合っていれば最後に meta を書く。合わなければ止まるので、
--full で入れ直す。

書き込みは主キーで消す・置き換える文だけなので、途中で失敗しても同じコマンドを流し直せばよい。
差分は法人番号の順に、法人 CHUNK 社ずつまとめて書く。gram と city は毎回全部を書き直す。
"""

import argparse
import json
import sqlite3
import subprocess
import sys
import tempfile
import urllib.request
from collections.abc import Iterable, Iterator
from pathlib import Path

import duckdb

SOURCE = "https://data.queria.io/datasets/queria/company_resolver/"
WORKER = Path(__file__).resolve().parents[1] / "worker"

# Worker (worker/src/forward.ts) が引くテーブル。company は posting から法人ごとに 1 行を取ったもの
SCHEMA = [
    "CREATE TABLE company (corporate_number TEXT PRIMARY KEY, core TEXT NOT NULL, legal_form TEXT,"
    " lg_code TEXT, name TEXT) WITHOUT ROWID",
    "CREATE TABLE gram (g TEXT PRIMARY KEY, df INTEGER NOT NULL, idf REAL NOT NULL) WITHOUT ROWID",
    "CREATE TABLE posting (g TEXT NOT NULL, lg_code TEXT NOT NULL, corporate_number TEXT NOT NULL,"
    " PRIMARY KEY (g, lg_code, corporate_number)) WITHOUT ROWID",
    "CREATE TABLE city (lg_code TEXT PRIMARY KEY, prefecture_name TEXT NOT NULL, city_name TEXT NOT NULL)"
    " WITHOUT ROWID",
    "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID",
]
INDEXES = ["CREATE INDEX company_core ON company (core)"]
TABLES = ["company", "gram", "posting", "city", "meta"]

# 元データのテーブルから D1 の行を取る式。{s} は ATTACH した名前
ROWS = {
    "company": "SELECT DISTINCT corporate_number, core, legal_form, lg_code, name FROM {s}.forward.posting",
    "gram": "SELECT g, df, idf FROM {s}.forward.gram",
    "posting": "SELECT g, coalesce(lg_code, '') AS lg_code, corporate_number FROM {s}.forward.posting",
    "city": "SELECT lg_code, prefecture_name, city_name FROM {s}.forward.city",
}
KEYS = {"company": ["corporate_number"], "gram": ["g"], "posting": ["g", "lg_code", "corporate_number"],
        "city": ["lg_code"]}

ROWS_PER_STATEMENT = 500
# D1 の import に渡す 1 ファイルの大きさの上限
BYTES_PER_FILE = 900 * 2**20
# 差分を書くときに 1 つにまとめる法人の数
CHUNK = 200


def literal(v: object) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


def values(rows: Iterable[tuple]) -> str:
    return ",".join("(" + ",".join(map(literal, r)) + ")" for r in rows)


def batches(rows: list[tuple]) -> Iterator[list[tuple]]:
    for i in range(0, len(rows), ROWS_PER_STATEMENT):
        yield rows[i : i + ROWS_PER_STATEMENT]


def insert(table: str, rows: list[tuple], verb: str = "INSERT") -> Iterator[str]:
    for b in batches(rows):
        yield f"{verb} INTO {table} VALUES {values(b)}"


def delete(table: str, rows: list[tuple]) -> Iterator[str]:
    """主キーの値で消す。1 列なら IN (…)、複数列なら行値の IN (VALUES …)"""
    keys = KEYS[table]
    for b in batches(rows):
        if len(keys) == 1:
            yield f"DELETE FROM {table} WHERE {keys[0]} IN ({','.join(literal(r[0]) for r in b)})"
        else:
            yield f"DELETE FROM {table} WHERE ({', '.join(keys)}) IN (VALUES {values(b)})"


def write_files(statements: Iterable[str], out: Path) -> list[Path]:
    """1 行 1 文の SQL ファイルに分けて書く。BEGIN / COMMIT は D1 が受け付けないので書かない"""
    out.mkdir(parents=True, exist_ok=True)
    files: list[Path] = []
    f = None
    for s in statements:
        if f is None or f.tell() > BYTES_PER_FILE:
            if f:
                f.close()
            files.append(out / f"{len(files):03}.sql")
            f = files[-1].open("w")
        f.write(s + ";\n")
    if f:
        f.close()
    return files


def full(con: duckdb.DuckDBPyConnection, new: str) -> Iterator[str]:
    """テーブルを作り直して全件を入れる文。索引は行を入れた後に作る"""
    yield from (f"DROP TABLE IF EXISTS {t}" for t in TABLES)
    yield from SCHEMA
    for table, query in ROWS.items():
        cur = con.execute(query.format(s=new) + f" ORDER BY {', '.join(KEYS[table])}")
        while rows := cur.fetchmany(ROWS_PER_STATEMENT):
            yield f"INSERT INTO {table} VALUES {values(rows)}"
    yield from INDEXES


def diff(con: duckdb.DuckDBPyConnection, old: str, new: str) -> Iterator[str]:
    """old から new に変わった行だけを書く文。法人番号の順に CHUNK 社ずつ、消す行・置き換える行をまとめる"""
    for table in ["company", "posting"]:
        o, n = ROWS[table].format(s=old), ROWS[table].format(s=new)
        con.execute(f"CREATE OR REPLACE TEMP TABLE add_{table} AS {n} EXCEPT {o}")
        con.execute(f"CREATE OR REPLACE TEMP TABLE del_{table} AS {o} EXCEPT {n}")
    # 置き換える法人 (add_company) は主キーで上書きするので、消すのは new に無い法人だけ
    con.execute("DELETE FROM del_company WHERE corporate_number IN (SELECT corporate_number FROM add_company)")
    con.execute("""
        CREATE OR REPLACE TEMP TABLE chunk AS
        SELECT corporate_number, (row_number() OVER (ORDER BY corporate_number) - 1) // ? AS chunk
        FROM (SELECT corporate_number FROM add_company UNION SELECT corporate_number FROM del_company
              UNION SELECT corporate_number FROM add_posting UNION SELECT corporate_number FROM del_posting)
    """, [CHUNK])

    def grouped(name: str) -> dict[int, list[tuple]]:
        cols = ", ".join(f"t.{d[0]}" for d in con.execute(f"SELECT * FROM {name} LIMIT 0").description)
        out: dict[int, list[tuple]] = {}
        for chunk, *row in con.execute(
            f"SELECT c.chunk, {cols} FROM {name} t JOIN chunk c USING (corporate_number) ORDER BY 1, 2"
        ).fetchall():
            out.setdefault(chunk, []).append(tuple(row))
        return out

    parts = {name: grouped(name) for name in ["del_posting", "del_company", "add_company", "add_posting"]}
    chunks = con.execute("SELECT max(chunk) + 1 FROM chunk").fetchone()[0] or 0
    for c in range(chunks):
        yield from delete("posting", parts["del_posting"].get(c, []))
        yield from delete("company", parts["del_company"].get(c, []))
        yield from insert("company", parts["add_company"].get(c, []), "INSERT OR REPLACE")
        yield from insert("posting", parts["add_posting"].get(c, []), "INSERT OR IGNORE")
    # df と IDF は法人の数で変わるので、gram は全部を書き直す。city も小さいので全部
    for table in ["gram", "city"]:
        key = KEYS[table][0]
        gone = con.execute(
            f"SELECT {key} FROM ({ROWS[table].format(s=old)}) EXCEPT SELECT {key} FROM ({ROWS[table].format(s=new)})"
        ).fetchall()
        yield from delete(table, gone)
        rows = con.execute(ROWS[table].format(s=new) + f" ORDER BY {key}").fetchall()
        yield from insert(table, rows, "INSERT OR REPLACE")


class D1:
    """wrangler で D1 に流す (worker/ の wrangler.jsonc のデータベース)"""

    def __init__(self, database: str):
        self.database = database

    def _wrangler(self, *args: str) -> str:
        cmd = ["pnpm", "exec", "wrangler", "d1", "execute", self.database, "--remote", "-y", *args]
        return subprocess.run(cmd, cwd=WORKER, check=True, capture_output=True, text=True).stdout

    def query(self, sql: str) -> list[dict]:
        out = json.loads(self._wrangler("--json", "--command", sql), strict=False)
        return out[0]["results"]

    def run_file(self, path: Path) -> None:
        self._wrangler("--file", str(path))


class SQLite:
    """D1 の代わりに手元の SQLite ファイルに流す"""

    def __init__(self, path: str):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row

    def query(self, sql: str) -> list[dict]:
        rows = [dict(r) for r in self.db.execute(sql).fetchall()]
        self.db.commit()
        return rows

    def run_file(self, path: Path) -> None:
        self.db.executescript(path.read_text())
        self.db.commit()


def applied_version(target: D1 | SQLite) -> str | None:
    if not target.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'"):
        return None
    rows = target.query("SELECT value FROM meta WHERE key = 'version'")
    return rows[0]["value"] if rows else None


def attach(con: duckdb.DuckDBPyConnection, source: str, version: str, alias: str) -> None:
    con.execute(f"ATTACH 'ducklake:{source}versions/{version}/ducklake.duckdb' AS {alias} (READ_ONLY)")


def verify(con: duckdb.DuckDBPyConnection, target: D1 | SQLite, new: str) -> None:
    """法人数と posting の行数を元データと照合する"""
    want = con.execute(
        f"SELECT count(DISTINCT corporate_number), count(*) FROM {new}.forward.posting"
    ).fetchone()
    got = target.query("SELECT (SELECT count(*) FROM company) AS company, (SELECT count(*) FROM posting) AS posting")[0]
    print(f"company: {got['company']} / {want[0]}, posting: {got['posting']} / {want[1]}", flush=True)
    if (got["company"], got["posting"]) != tuple(want):
        sys.exit("D1 の行数が元データと合いません。--full で入れ直してください")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--full", action="store_true", help="全件を入れ直す")
    p.add_argument("--database", default="company-resolver", help="D1 のデータベース名")
    p.add_argument("--sqlite", help="D1 の代わりに反映する手元の SQLite ファイル")
    p.add_argument("--source", default=SOURCE, help="FDL のリポジトリの URL (…/)")
    args = p.parse_args()

    target = SQLite(args.sqlite) if args.sqlite else D1(args.database)
    # 既定の User-Agent (Python-urllib) は data.queria.io に断られる
    req = urllib.request.Request(f"{args.source}refs/heads/main", headers={"User-Agent": "company-resolver-sync"})
    with urllib.request.urlopen(req) as res:
        version = res.read().decode().strip()
    applied = None if args.full else applied_version(target)
    print(f"source: {version}, applied: {applied}", flush=True)
    if applied == version:
        print("反映済みです")
        return

    con = duckdb.connect()
    con.execute("INSTALL ducklake; LOAD ducklake")
    attach(con, args.source, version, "new")
    statements: Iterable[str] = []
    if applied is not None:
        try:
            attach(con, args.source, applied, "old")
            # 前のバージョンの表を読むのはここ (diff はジェネレータなので、list にして読み切る)
            statements = list(diff(con, "old", "new"))
        except duckdb.Error as e:
            print(f"前のバージョン {applied} を読めないので、全件を入れ直します: {e}", flush=True)
            applied = None
    if applied is None:
        statements = full(con, "new")

    with tempfile.TemporaryDirectory() as tmp:
        files = write_files(statements, Path(tmp))
        for f in files:
            print(f"{f.name}: {f.stat().st_size / 2**20:.1f} MB", flush=True)
            target.run_file(f)
    verify(con, target, "new")
    target.query(f"INSERT OR REPLACE INTO meta VALUES ('version', {literal(version)})")
    print(f"反映しました: {version}")


if __name__ == "__main__":
    main()
