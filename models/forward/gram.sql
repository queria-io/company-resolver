-- bigram ごとの、出現する法人の数 (df) と IDF。Worker は番号 (shard) のファイルを丸ごと読む
SELECT {{ gram_shard('g') }} AS shard, g, count(*) AS df,
    ln((SELECT count(*) FROM {{ ref('company_name') }}) / count(*)) AS idf
FROM {{ ref('posting') }}
GROUP BY g
ORDER BY shard, g
