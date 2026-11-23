-- 商号 (旧商号を含む) の本体の bigram ごとの法人。gram の出現数と、posting_rare・posting_common の元。
-- 今の商号と旧商号に同じ bigram があれば、本体ごとに 1 行ずつ持つ
SELECT DISTINCT g, lg_code, corporate_number, core
FROM (SELECT unnest({{ bigrams('core') }}) AS g, lg_code, corporate_number, core FROM {{ ref('company_core') }})
ORDER BY g, lg_code, corporate_number, core
