"""テスト用の小さな索引を test/fixture/ に作る。

usage (prototype/ の仮想環境で): python test/make-fixture.py
法人は架空のもの。並びと規則を試すために、同じ商号を別の市区町村に置いている
"""
import sys
import tempfile
from datetime import date
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent.parent / "prototype"))

from build_index import build  # noqa: E402
from export_company import export as export_company  # noqa: E402
from export_parquet import export  # noqa: E402

COMPANIES = [
    ("1000000000001", "株式会社クエリア", "東京都", "千代田区", "131016"),
    ("1000000000002", "株式会社クエリア", "東京都", "府中市", "132063"),
    ("1000000000003", "株式会社クエリア", "広島県", "府中市", "342084"),
    ("1000000000004", "クエリア商事株式会社", "東京都", "千代田区", "131016"),
    ("1000000000005", "有限会社クエリア", "北海道", "札幌市中央区", "011011"),
    ("1000000000006", "株式会社キヤリアバンク", "東京都", "中央区", "131024"),
    ("1000000000007", "株式会社テスト工業", "東京都", "中央区", "131024"),
    ("1000000000008", "テスト工業株式会社", "大阪府", "大阪市北区", "271276"),
]


# 逆引きの履歴 (mart_houjin_bangou_history の列のうち export_company.py が読むもの)。
# 1000000000001 は商号と所在地を 1 回ずつ変えた法人、1000000000009 は商号を変えたあと合併で閉鎖した法人
HISTORY_COLUMNS = ["corporate_number", "history_seq", "is_latest", "change_date", "name", "furigana", "kind",
                   "prefecture_name", "city_name", "street_number", "lg_code", "assignment_date", "close_date",
                   "close_cause", "successor_corporate_number"]


def history_rows() -> list[tuple]:
    first = date(2015, 10, 5)
    rows = [(c[0], 1, c[0] != "1000000000001", first, c[1], None, "301", c[2], c[3], "1-1", c[4], first, None, None,
             None) for c in COMPANIES]
    return rows + [
        ("1000000000001", 2, False, date(2020, 4, 1), "株式会社クエリア", None, "301", "東京都", "中央区", "2-2",
         "131024", first, None, None, None),
        ("1000000000001", 3, True, date(2022, 4, 1), "株式会社クエリア", None, "301", "東京都", "千代田区", "1-1",
         "131016", first, None, None, None),
        ("1000000000009", 1, False, first, "クエリア工業株式会社", None, "301", "東京都", "千代田区", "1-1", "131016",
         first, None, None, None),
        ("1000000000009", 2, True, date(2023, 1, 1), "旧クエリア株式会社", None, "301", "東京都", "千代田区", "1-1",
         "131016", first, date(2023, 1, 1), "11", "1000000000001"),
    ]


def main() -> None:
    cols = list(zip(*COMPANIES))
    table = pa.table({
        "corporate_number": cols[0], "name": cols[1], "furigana": [None] * len(COMPANIES),
        "kind": ["301"] * len(COMPANIES), "prefecture_name": cols[2], "city_name": cols[3],
        "street_number": ["1-1"] * len(COMPANIES), "lg_code": cols[4],
    })
    with tempfile.TemporaryDirectory() as tmp:
        pq.write_table(table, f"{tmp}/houjin.parquet")
        build(f"{tmp}/houjin.parquet", tmp)
        export(tmp, str(HERE / "fixture"))
        history = pa.Table.from_pylist([dict(zip(HISTORY_COLUMNS, r)) for r in history_rows()])
        pq.write_table(history, f"{tmp}/history.parquet")
        export_company(f"{tmp}/history.parquet", str(HERE / "fixture"))


if __name__ == "__main__":
    main()
