-- 国の機関 (法人種別 101) と地方公共団体 (201) の一覧。Worker は丸ごと読み、入力の先頭がこれらの名前で、
-- 後ろに部局の名前が続くとき (例: 国土交通省関東地方整備局)、親の機関の法人番号を返す。
-- prefixed_core は都道府県名を付けた名前の本体 (東京都千代田区役所 のように書かれる市区町村などを引くため)
WITH b AS (
    SELECT c.corporate_number, c.name, {{ core_name('c.name') }} AS core, h.kind, c.prefecture_name, c.lg_code,
        {{ core_name('c.prefecture_name') }} AS prefecture_core
    FROM {{ ref('company_name') }} c
    JOIN houjin_bangou.main.mart_houjin_bangou h USING (corporate_number)
    WHERE h.kind IN ('101', '201')
)
SELECT corporate_number, name, core, kind, prefecture_name, lg_code,
    CASE WHEN kind = '201' AND prefecture_core <> '' AND NOT starts_with(core, prefecture_core)
        THEN prefecture_core || core END AS prefixed_core
FROM b
ORDER BY corporate_number
