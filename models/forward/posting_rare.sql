-- 共通でない bigram (出現する法人が national_rows 以下) ごとの法人。Worker は bigram の shard のファイルを丸ごと読む
-- (shard は worker/scripts/build-data.mjs が作る)
SELECT p.g, p.lg_code, p.corporate_number, c.legal_form, c.core, c.name
FROM {{ ref('posting') }} p
JOIN {{ ref('gram') }} gr USING (g)
JOIN {{ ref('company_core') }} c USING (corporate_number)
WHERE gr.common_id IS NULL
ORDER BY p.g, p.lg_code, p.corporate_number
