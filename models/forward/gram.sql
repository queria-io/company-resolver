-- bigram ごとの、出現する法人の数 (df) と IDF。scripts/sync_d1.py が D1 の gram に入れる
SELECT g, count(*) AS df,
    ln((SELECT count(*) FROM {{ ref('company_name') }}) / count(*)) AS idf
FROM {{ ref('posting') }}
GROUP BY g
ORDER BY g
