"""正引きの索引 (forward.company_core・forward.posting・forward.gram・forward.city) を D1 に反映する。

usage (リポジトリの直下で):
  uv run python scripts/sync_d1.py                 # D1 (worker/wrangler.jsonc の DB) に反映する
  uv run python scripts/sync_d1.py --full          # 全件を入れ直す
  uv run python scripts/sync_d1.py --sqlite FILE   # D1 の代わりに手元の SQLite に反映する (ベンチマーク用)

読む元は FDL の refs/heads/main が指すバージョン。D1 の meta に最後に反映したバージョンがあり、そのカタログを
読めれば、2 つのバージョンを比べて変わった行だけを書く。meta が無いとき・D1 のテーブルの定義 (SCHEMA) が
変わったとき・前のカタログを読めないとき・--full のときは、テーブルを作り直して全件を入れる
(そのあいだ正引きは失敗する)。
反映したら法人数と posting の行数を元データと照合し、合っていれば最後に meta を書く。合わなければ止まるので、
--full で入れ直す。

書き込みは主キーで消す・置き換える文だけなので、途中で失敗しても同じコマンドを流し直せばよい。
差分は法人番号の順に、法人 CHUNK 社ずつまとめて書く。gram と city は毎回全部を書き直す。
"""

import argparse
import hashlib
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

# Worker (worker/src/forward.ts) が引くテーブル
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
# テーブルの定義のバージョン。meta の schema と違えば全件を入れ直す
SCHEMA_VERSION = hashlib.sha256("\n".join(SCHEMA + INDEXES).encode()).hexdigest()[:12]

# 元データのテーブルから D1 の行を取る式。{s} は ATTACH した名前
ROWS = {
    "company": "SELECT corporate_number, core, legal_form, lg_code, name FROM {s}.forward.company_core",
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
# DuckDB から一度に取り出す行の数
FETCH = 10_000


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


def rows_of(con: duckdb.DuckDBPyConnection, table: str, s: str) -> str:
    """元データから D1 の行を取る式。forward.company_core の無いバージョンは、posting から法人ごとに 1 行を取る"""
    if table == "company" and not con.execute(
        "SELECT 1 FROM duckdb_tables() WHERE database_name = ? AND schema_name = 'forward' AND table_name = 'company_core'",
        [s],
    ).fetchone():
        return f"SELECT DISTINCT corporate_number, core, legal_form, lg_code, name FROM {s}.forward.posting"
    return ROWS[table].format(s=s)


def stream(con: duckdb.DuckDBPyConnection, query: str) -> Iterator[tuple]:
    """結果を FETCH 行ずつ取り出す。別のカーソルで流すので、ほかの結果を読んでいる途中でも使える"""
    cur = con.cursor().execute(query)
    while rows := cur.fetchmany(FETCH):
        yield from rows


def by_chunk(rows: Iterator[tuple]) -> Iterator[tuple[int, list[tuple]]]:
    """先頭の列 (chunk) の順に並んだ行を、chunk ごとにまとめる"""
    current, buf = None, []
    for chunk, *row in rows:
        if chunk != current and buf:
            yield current, buf
            buf = []
        current = chunk
        buf.append(tuple(row))
    if buf:
        yield current, buf


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
    for table in ROWS:
        cur = con.cursor().execute(rows_of(con, table, new) + f" ORDER BY {', '.join(KEYS[table])}")
        while rows := cur.fetchmany(ROWS_PER_STATEMENT):
            yield f"INSERT INTO {table} VALUES {values(rows)}"
    yield from INDEXES


def prepare_diff(con: duckdb.DuckDBPyConnection, old: str, new: str) -> None:
    """old と new を比べ、消す行・書く行を手元の表 (diff.*) に作る。前のバージョンの表を読むのはここ"""
    con.execute("CREATE SCHEMA IF NOT EXISTS memory.diff")
    for table in ["company", "posting"]:
        o, n = rows_of(con, table, old), rows_of(con, table, new)
        con.execute(f"CREATE OR REPLACE TABLE memory.diff.add_{table} AS {n} EXCEPT {o}")
        con.execute(f"CREATE OR REPLACE TABLE memory.diff.del_{table} AS {o} EXCEPT {n}")
    # 置き換える法人 (add_company) は主キーで上書きするので、消すのは new に無い法人だけ
    con.execute(
        "DELETE FROM memory.diff.del_company WHERE corporate_number IN (SELECT corporate_number FROM memory.diff.add_company)"
    )
    con.execute("""
        CREATE OR REPLACE TABLE memory.diff.chunk AS
        SELECT corporate_number, (row_number() OVER (ORDER BY corporate_number) - 1) // ? AS chunk
        FROM (SELECT corporate_number FROM memory.diff.add_company UNION SELECT corporate_number FROM memory.diff.del_company
              UNION SELECT corporate_number FROM memory.diff.add_posting UNION SELECT corporate_number FROM memory.diff.del_posting)
    """, [CHUNK])
    for table in ["gram", "city"]:
        key = KEYS[table][0]
        con.execute(f"""
            CREATE OR REPLACE TABLE memory.diff.del_{table} AS
            SELECT {key} FROM ({rows_of(con, table, old)}) EXCEPT SELECT {key} FROM ({rows_of(con, table, new)})
        """)


def diff(con: duckdb.DuckDBPyConnection, new: str) -> Iterator[str]:
    """prepare_diff で作った表から、変わった行だけを書く文。法人番号の順に CHUNK 社ずつ、消す行・置き換える行を
    まとめる。行は FETCH 行ずつ読み、全部をメモリに載せない"""
    parts = {}
    for name in ["del_posting", "del_company", "add_company", "add_posting"]:
        cols = ", ".join(f"t.{d[0]}" for d in con.execute(f"SELECT * FROM memory.diff.{name} LIMIT 0").description)
        parts[name] = by_chunk(stream(con, f"""
            SELECT c.chunk, {cols} FROM memory.diff.{name} t JOIN memory.diff.chunk c USING (corporate_number)
            ORDER BY c.chunk"""))
    pending: dict[str, tuple[int, list[tuple]] | None] = {name: next(it, None) for name, it in parts.items()}

    def take(name: str, chunk: int) -> list[tuple]:
        got = pending[name]
        if got is None or got[0] != chunk:
            return []
        pending[name] = next(parts[name], None)
        return got[1]

    chunks = con.execute("SELECT max(chunk) + 1 FROM memory.diff.chunk").fetchone()[0] or 0
    for c in range(chunks):
        yield from delete("posting", take("del_posting", c))
        yield from delete("company", take("del_company", c))
        yield from insert("company", take("add_company", c), "INSERT OR REPLACE")
        yield from insert("posting", take("add_posting", c), "INSERT OR IGNORE")
    # df と IDF は法人の数で変わるので、gram は全部を書き直す。city も小さいので全部
    for table in ["gram", "city"]:
        gone = stream(con, f"SELECT * FROM memory.diff.del_{table}")
        while b := [r for _, r in zip(range(ROWS_PER_STATEMENT), gone)]:
            yield from delete(table, b)
        rows = stream(con, rows_of(con, table, new) + f" ORDER BY {KEYS[table][0]}")
        while b := [r for _, r in zip(range(ROWS_PER_STATEMENT), rows)]:
            yield from insert(table, b, "INSERT OR REPLACE")


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


def applied_meta(target: D1 | SQLite) -> dict[str, str]:
    """D1 の meta (version: 最後に反映したバージョン、schema: そのときのテーブルの定義のバージョン)"""
    if not target.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'"):
        return {}
    return {r["key"]: r["value"] for r in target.query("SELECT key, value FROM meta")}


def attach(con: duckdb.DuckDBPyConnection, source: str, version: str, alias: str) -> None:
    con.execute(f"ATTACH 'ducklake:{source}versions/{version}/ducklake.duckdb' AS {alias} (READ_ONLY)")


def verify(con: duckdb.DuckDBPyConnection, target: D1 | SQLite, new: str) -> None:
    """法人数と posting の行数を元データと照合する"""
    want = (
        con.execute(f"SELECT count(*) FROM ({rows_of(con, 'company', new)})").fetchone()[0],
        con.execute(f"SELECT count(*) FROM {new}.forward.posting").fetchone()[0],
    )
    got = target.query("SELECT (SELECT count(*) FROM company) AS company, (SELECT count(*) FROM posting) AS posting")[0]
    print(f"company: {got['company']} / {want[0]}, posting: {got['posting']} / {want[1]}", flush=True)
    if (got["company"], got["posting"]) != want:
        sys.exit("D1 の行数が元データと合いません。--full で入れ直してください")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--full", action="store_true", help="全件を入れ直す")
    p.add_argument("--database", default="DB", help="D1 のデータベース名か、wrangler.jsonc のバインディング名")
    p.add_argument("--sqlite", help="D1 の代わりに反映する手元の SQLite ファイル")
    p.add_argument("--source", default=SOURCE, help="FDL のリポジトリの URL (…/)")
    args = p.parse_args()

    target = SQLite(args.sqlite) if args.sqlite else D1(args.database)
    # 既定の User-Agent (Python-urllib) は data.queria.io に断られる
    req = urllib.request.Request(f"{args.source}refs/heads/main", headers={"User-Agent": "company-resolver-sync"})
    with urllib.request.urlopen(req) as res:
        version = res.read().decode().strip()
    meta = {} if args.full else applied_meta(target)
    applied = meta.get("version")
    print(f"source: {version}, applied: {applied}, schema: {meta.get('schema')} -> {SCHEMA_VERSION}", flush=True)
    if applied is not None and meta.get("schema") != SCHEMA_VERSION:
        print("D1 のテーブルの定義が変わったので、全件を入れ直します", flush=True)
        applied = None
    if applied == version:
        print("反映済みです")
        return

    con = duckdb.connect()
    con.execute("INSTALL ducklake; LOAD ducklake")
    attach(con, args.source, version, "new")
    if applied is not None:
        try:
            attach(con, args.source, applied, "old")
            prepare_diff(con, "old", "new")
        except duckdb.Error as e:
            print(f"前のバージョン {applied} を読めないので、全件を入れ直します: {e}", flush=True)
            applied = None
    statements = diff(con, "new") if applied is not None else full(con, "new")

    with tempfile.TemporaryDirectory() as tmp:
        files = write_files(statements, Path(tmp))
        for f in files:
            print(f"{f.name}: {f.stat().st_size / 2**20:.1f} MB", flush=True)
            target.run_file(f)
    verify(con, target, "new")
    # 最後に書く。途中で止まれば meta は前のままなので、次の回も同じ差分を流し直す
    target.query(
        f"INSERT OR REPLACE INTO meta VALUES ('schema', {literal(SCHEMA_VERSION)}), ('version', {literal(version)})"
    )
    print(f"反映しました: {version}")

if __name__ == "__main__":
    main()
