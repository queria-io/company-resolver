-- 法人ごとの商号の本体・法人格・lg_code・商号。scripts/sync_d1.py が D1 の company に入れる
SELECT corporate_number,
    {{ core_name('name') }} AS core,
    {{ legal_form('name') }} AS legal_form,
    lg_code, name
FROM {{ ref('company_name') }}
WHERE {{ core_name('name') }} <> ''
ORDER BY corporate_number
