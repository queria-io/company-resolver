-- 法人ごとの最新の状態と、旧商号・旧所在地。閉鎖した法人も含める。
-- 前の行と比べて、商号が変わった行の前の商号と、所在地が変わった行の前の所在地を、変わった日とともに集める。
-- Worker は法人番号の下 3 桁 (shard) のファイルを開き、行グループの corporate_number の最小・最大で選ぶ
WITH h AS (
    SELECT *,
        lag(name) OVER w AS prev_name,
        lag(prefecture_name) OVER w AS prev_prefecture,
        lag(city_name) OVER w AS prev_city,
        lag(street_number) OVER w AS prev_street_number,
        lag(lg_code) OVER w AS prev_lg_code
    FROM houjin_bangou.main.mart_houjin_bangou_history
    WINDOW w AS (PARTITION BY corporate_number ORDER BY history_seq)
),
former_names AS (
    SELECT corporate_number, list({'name': prev_name, 'until': change_date} ORDER BY history_seq) AS former_names
    FROM h WHERE prev_name IS NOT NULL AND prev_name <> name
    GROUP BY corporate_number
),
former_addresses AS (
    SELECT corporate_number, list({
        'prefecture': prev_prefecture, 'city': prev_city, 'street_number': prev_street_number,
        'lg_code': prev_lg_code, 'until': change_date
    } ORDER BY history_seq) AS former_addresses
    FROM h
    WHERE history_seq > 1
        AND (prev_prefecture, prev_city, prev_street_number) IS DISTINCT FROM (prefecture_name, city_name, street_number)
    GROUP BY corporate_number
)
SELECT right(corporate_number, 3) AS shard, corporate_number, name, furigana, kind,
    prefecture_name, city_name, street_number, lg_code, assignment_date,
    close_date, close_cause, successor_corporate_number, former_names, former_addresses
FROM h LEFT JOIN former_names USING (corporate_number) LEFT JOIN former_addresses USING (corporate_number)
WHERE is_latest
ORDER BY shard, corporate_number
