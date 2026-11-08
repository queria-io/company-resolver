-- 商号の正規化。Worker の src/normalize.ts と同じ規則にする (NFKC は models/forward/company_name.py で済ませる)

-- 法人格 (株式会社・有限会社・合同会社・合資会社・合名会社と、その略記)。無ければ NULL
{% macro legal_form(s) -%}
CASE
  WHEN regexp_matches({{ s }}, '株式会社|\(株\)') THEN '株式会社'
  WHEN regexp_matches({{ s }}, '有限会社|\(有\)') THEN '有限会社'
  WHEN regexp_matches({{ s }}, '合同会社|\(同\)') THEN '合同会社'
  WHEN regexp_matches({{ s }}, '合資会社|\(資\)') THEN '合資会社'
  WHEN regexp_matches({{ s }}, '合名会社|\(名\)') THEN '合名会社'
END
{%- endmacro %}

-- 商号の本体: 法人格と空白・中黒・ハイフン類を除き、英字を大文字に、小書きの仮名を大きい仮名にする
-- (商業登記では小書きの仮名を使えないため、両側で大きい仮名に揃える)
{% macro core_name(s) -%}
translate(
  upper(regexp_replace(
    regexp_replace({{ s }}, '株式会社|有限会社|合同会社|合資会社|合名会社|\((株|有|同|資|名)\)', '', 'g'),
    '[\s・‐―−–—-]', '', 'g')),
  'ァィゥェォッャュョヮヵヶぁぃぅぇぉっゃゅょゎ', 'アイウエオツヤユヨワカケあいうえおつやゆよわ')
{%- endmacro %}

-- 文字 bigram (重複を除く)。1 文字の商号はその 1 文字
{% macro bigrams(s) -%}
CASE WHEN length({{ s }}) <= 1 THEN [{{ s }}]
     ELSE list_distinct([substr({{ s }}, i, 2) FOR i IN range(1, length({{ s }}))]) END
{%- endmacro %}

-- bigram のファイルの番号: 文字のコードポイントの和を 1,024 で割った余り (src/normalize.ts の shardOf)
{% macro gram_shard(g) -%}
CAST(list_sum([unicode(substr({{ g }}, i, 1)) FOR i IN range(1, length({{ g }}) + 1)]) % 1024 AS INTEGER)
{%- endmacro %}

-- 商号が同じ法人の表 (forward.exact_name) のファイルの番号: 商号の本体のコードポイントの和を 4,096 で割った余り
-- (src/normalize.ts の shardOf。Worker は入力の商号の番号のファイルを丸ごと読む)
{% macro name_shard(core) -%}
CAST(list_sum([unicode(substr({{ core }}, i, 1)) FOR i IN range(1, length({{ core }}) + 1)]) % 4096 AS INTEGER)
{%- endmacro %}
