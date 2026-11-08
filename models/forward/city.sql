-- 市区町村の lg_code と名前。Worker は住所から市区町村を切り出すのに、丸ごと読む
SELECT DISTINCT lg_code, prefecture_name, city_name
FROM {{ ref('company_name') }}
WHERE city_name <> ''
ORDER BY lg_code
