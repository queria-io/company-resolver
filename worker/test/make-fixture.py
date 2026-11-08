"""テスト用の小さな索引を test/fixture/ に作る。

usage (prototype/ の仮想環境で): python test/make-fixture.py
法人は架空のもの。並びと規則を試すために、同じ商号を別の市区町村に置いている
"""
import sys
import tempfile
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent.parent / "prototype"))

from build_index import build  # noqa: E402
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


if __name__ == "__main__":
    main()
