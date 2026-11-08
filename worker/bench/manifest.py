"""手元で dbt を流して作った索引の目録 (src/source.ts) を書く。bench/run.ts と test/make-fixture.py が使う。

usage (リポジトリの直下で): uv run python worker/bench/manifest.py <work.sqlite> <data_dir>
<data_dir>/manifest.json に、テーブルごとのファイル (data_dir からの相対パス) を書く
"""
import json
import sys
from pathlib import Path

import duckdb

TABLES = ["forward.exact_name", "forward.posting", "forward.gram", "forward.city", "reverse.company"]


def write_manifest(catalog: str, data_dir: str) -> None:
    con = duckdb.connect()
    con.execute(f"ATTACH 'ducklake:sqlite:{catalog}' AS c (READ_ONLY)")
    root = Path(data_dir).resolve()
    tables = {
        t: sorted(Path(f).resolve().relative_to(root).as_posix() for (f,) in con.execute(
            "SELECT data_file FROM ducklake_list_files('c', ?, schema => ?)", [t.split(".")[1], t.split(".")[0]]
        ).fetchall())
        for t in TABLES
    }
    (root / "manifest.json").write_text(json.dumps({"version": "local", "tables": tables}, indent=2) + "\n")


if __name__ == "__main__":
    write_manifest(sys.argv[1], sys.argv[2])
