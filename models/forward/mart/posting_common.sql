-- 共通の bigram (出現する法人が national_rows を超える) ごとの法人。bigram の番号 (common_id) と、市区町村の区分
-- (bucket) ごとにファイルを分ける。Worker は住所の市区町村の区分のファイルを丸ごと読む
SELECT gr.common_id, {{ city_bucket('p.lg_code', var('forward_city_buckets')) }} AS bucket,
    p.g, p.lg_code, p.corporate_number, c.legal_form, c.core, c.name
FROM {{ ref('posting') }} p
JOIN {{ ref('gram') }} gr USING (g)
JOIN {{ ref('company_core') }} c USING (corporate_number)
WHERE gr.common_id IS NOT NULL
ORDER BY gr.common_id, bucket, p.lg_code, p.corporate_number
