-- 正規化した商号の本体が同じ法人。Worker は入力の商号の番号 (shard) のファイルを丸ごと読み、
-- 商号が一致する法人があれば bigram の索引を引かずに答える
WITH company AS (
    SELECT corporate_number, name, lg_code,
        {{ legal_form('name') }} AS legal_form,
        {{ core_name('name') }} AS core
    FROM {{ ref('company_name') }}
)
SELECT {{ name_shard('core') }} AS shard, core, lg_code, corporate_number, legal_form, name
FROM company
WHERE core <> ''
ORDER BY shard, core, lg_code, corporate_number
