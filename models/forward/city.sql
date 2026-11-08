-- 市区町村の lg_code と名前。scripts/sync_d1.py が D1 の city に入れ、Worker は住所から市区町村を切り出すのに使う
SELECT DISTINCT lg_code, prefecture_name, city_name
FROM {{ ref('company_name') }}
WHERE city_name <> ''
ORDER BY lg_code
