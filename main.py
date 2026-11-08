"""法人名寄せの索引を作る。

元は Queria の公開データセット（houjin_bangou）で、取得はしない。dbt を回すだけ。
"""

from dbt.cli.main import dbtRunner


def main():
    dbt = dbtRunner()
    for args in (["deps"], ["run"], ["docs", "generate"]):
        if not dbt.invoke(args).success:
            raise SystemExit(f"dbt {args[0]} failed")


if __name__ == "__main__":
    main()
