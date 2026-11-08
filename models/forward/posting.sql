-- 商号の bigram ごとの法人。Worker は bigram の番号 (shard) のファイルを開き、
-- 行グループの g と lg_code の最小・最大で読む行グループを選ぶので、この順に並べる
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
