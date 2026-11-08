-- 商号の bigram ごとの法人。scripts/sync_d1.py が D1 の posting に入れる
SELECT g, lg_code, corporate_number
FROM (SELECT unnest({{ bigrams('core') }}) AS g, lg_code, corporate_number FROM {{ ref('company_core') }})
ORDER BY g, lg_code, corporate_number
