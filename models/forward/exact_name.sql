-- 正規化した商号の本体が同じ法人。Worker は入力の商号の本体の shard のファイルを丸ごと読み、
-- 商号が一致する法人が 1 件に決まれば bigram の索引を引かずに答える (shard は worker/scripts/build-data.mjs が作る)
SELECT core, lg_code, corporate_number, legal_form, name
FROM {{ ref('company_core') }}
ORDER BY core, lg_code, corporate_number
