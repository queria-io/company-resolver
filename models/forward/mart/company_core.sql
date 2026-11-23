-- 法人ごとの商号の本体・法人格・lg_code・商号と、旧商号で引くための行。正引きの索引 (exact_name・posting_rare・posting_common) の元。
-- 旧商号の行は、本体と法人格を旧商号から作り、商号 (name) と lg_code は今のものにして、former に旧商号を入れる。
-- 本体と法人格が今の商号か別の旧商号と同じ行は 1 つにする (今の商号の行を残す)
WITH n AS (
    SELECT corporate_number, name AS key_name, NULL AS former FROM {{ ref('company_name') }}
    UNION ALL
    SELECT corporate_number, name, name FROM {{ ref('former_name') }}
)
SELECT n.corporate_number,
    {{ core_name('n.key_name') }} AS core,
    {{ legal_form('n.key_name') }} AS legal_form,
    c.lg_code, c.name, n.former
FROM n JOIN {{ ref('company_name') }} c USING (corporate_number)
WHERE {{ core_name('n.key_name') }} <> ''
QUALIFY row_number() OVER (PARTITION BY n.corporate_number, core, legal_form ORDER BY n.former NULLS FIRST) = 1
ORDER BY corporate_number, former NULLS FIRST
