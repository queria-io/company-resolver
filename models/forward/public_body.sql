-- 国の機関 (法人種別 101) と地方公共団体 (201) の一覧。Worker は丸ごと読み、入力の先頭がこれらの名前で、
-- 後ろに部局の名前が続くとき (例: 国土交通省関東地方整備局)、親の機関の法人番号を返す
SELECT c.corporate_number, c.name, {{ core_name('c.name') }} AS core, h.kind, c.prefecture_name, c.lg_code
FROM {{ ref('company_name') }} c
JOIN houjin_bangou.main.mart_houjin_bangou h USING (corporate_number)
WHERE h.kind IN ('101', '201')
ORDER BY c.corporate_number
