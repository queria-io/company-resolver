-- 正規化した商号の本体が同じ法人。Worker は入力の商号の本体の shard のファイルを丸ごと読み、
-- 商号が一致する法人が 1 件に決まれば bigram の索引を引かずに答える
SELECT {{ codepoint_shard('core', var('forward_name_shards')) }} AS shard, core, lg_code, corporate_number, legal_form, name
FROM {{ ref('company_core') }}
ORDER BY shard, core, lg_code, corporate_number
