-- bigram ごとの、出現する法人の数 (df) と IDF。Worker は shard のファイルを丸ごと読む。
-- 出現する法人が national_rows を超える bigram (共通の bigram) には番号 (common_id) を付け、
-- その行は posting_common に、ほかの bigram の行は posting_rare に置く
WITH g AS (
    SELECT g, count(*) AS df,
        ln((SELECT count(*) FROM {{ ref('company_name') }}) / count(*)) AS idf
    FROM {{ ref('posting') }}
    GROUP BY g
)
SELECT {{ codepoint_shard('g', var('forward_gram_shards')) }} AS shard, g, df, idf,
    CASE WHEN df > {{ var('forward_national_rows') }}
        THEN CAST(row_number() OVER (PARTITION BY df > {{ var('forward_national_rows') }} ORDER BY g) AS INTEGER)
    END AS common_id
FROM g
ORDER BY shard, g
