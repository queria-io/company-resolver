-- bigram ごとの、出現する法人の数 (df。今の商号と旧商号の両方にあっても 1 社と数える) と IDF。Worker は shard のファイルを丸ごと読む (shard は worker/scripts/build-data.mjs が作る)。
-- 出現する法人が national_rows を超える bigram (共通の bigram) には番号 (common_id) を付け、
-- その行は posting_common に、ほかの bigram の行は posting_rare に置く
WITH g AS (
    SELECT g, count(DISTINCT corporate_number) AS df,
        ln((SELECT count(*) FROM {{ ref('company_name') }}) / count(DISTINCT corporate_number)) AS idf
    FROM {{ ref('posting') }}
    GROUP BY g
)
SELECT g, df, idf,
    CASE WHEN df > {{ var('forward_national_rows') }}
        THEN CAST(row_number() OVER (PARTITION BY df > {{ var('forward_national_rows') }} ORDER BY g) AS INTEGER)
    END AS common_id
FROM g
ORDER BY g
