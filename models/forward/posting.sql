-- 商号の bigram ごとの法人。gram の出現数と、posting_rare・posting_common の元
SELECT g, lg_code, corporate_number
FROM (SELECT unnest({{ bigrams('core') }}) AS g, lg_code, corporate_number FROM {{ ref('company_core') }})
ORDER BY g, lg_code, corporate_number
