-- 正規化: NFKC 済みの文字列を受け取り、法人格を分けて商号の本体を返す。
-- 法人格は除いて索引を作り、比較では別の列として突き合わせる。
CREATE OR REPLACE MACRO legal_form(s) AS (
  CASE
    WHEN s ~ '(株式会社|\(株\))' THEN '株式会社'
    WHEN s ~ '(有限会社|\(有\))' THEN '有限会社'
    WHEN s ~ '(合同会社|\(同\))' THEN '合同会社'
    WHEN s ~ '(合資会社|\(資\))' THEN '合資会社'
    WHEN s ~ '(合名会社|\(名\))' THEN '合名会社'
    ELSE NULL
  END
);
-- 商業登記では小書きの仮名（ャ・ッ など）を使えないため、両側で大きい仮名に揃える
CREATE OR REPLACE MACRO large_kana(s) AS (
  translate(s, 'ァィゥェォッャュョヮヵヶぁぃぅぇぉっゃゅょゎ', 'アイウエオツヤユヨワカケあいうえおつやゆよわ')
);
CREATE OR REPLACE MACRO core_name(s) AS (
  large_kana(upper(regexp_replace(
    regexp_replace(s, '株式会社|有限会社|合同会社|合資会社|合名会社|\((株|有|同|資|名)\)', '', 'g'),
    '[\s・‐―−–—-]', '', 'g')))
);
-- 文字 bigram（1 文字の商号はその 1 文字）
CREATE OR REPLACE MACRO bigrams(s) AS (
  CASE WHEN length(s) <= 1 THEN [s]
       ELSE list_distinct([substr(s, i, 2) FOR i IN range(1, length(s))]) END
);
