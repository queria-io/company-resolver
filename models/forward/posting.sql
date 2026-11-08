-- 商号の bigram ごとの法人。scripts/sync_d1.py が D1 の posting と company に入れる
WITH company AS (
    SELECT corporate_number, name, lg_code,
        {{ legal_form('name') }} AS legal_form,
        {{ core_name('name') }} AS core
    FROM {{ ref('company_name') }}
),
gram AS (
    SELECT unnest({{ bigrams('core') }}) AS g, * FROM company WHERE core <> ''
)
SELECT {{ gram_shard('g') }} AS shard, g, lg_code, corporate_number, legal_form, core, name
FROM gram
ORDER BY shard, g, lg_code, corporate_number
