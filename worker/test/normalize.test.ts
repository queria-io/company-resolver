import { describe, expect, it } from "vitest";

import { bigrams, coreName, legalForm, levenshtein, nfkc, shardOf } from "../src/normalize";

describe("normalize", () => {
  it("法人格を分けて商号の本体を取る", () => {
    const name = nfkc("㈱ クエリア・ラボ");
    expect(legalForm(name)).toBe("株式会社");
    expect(coreName(name)).toBe("クエリアラボ");
    expect(legalForm("クエリア")).toBeNull();
  });

  it("小書きの仮名を大きい仮名に、英字を大文字に揃える", () => {
    expect(coreName(nfkc("キャリアバンク株式会社"))).toBe("キヤリアバンク");
    expect(coreName(nfkc("ｑｕｅｒｉａ合同会社"))).toBe("QUERIA");
  });

  it("ハイフン類を除く", () => {
    expect(coreName("A−B–C—D-E")).toBe("ABCDE");
  });

  it("bigram は重複を除き、1 文字の商号はその 1 文字", () => {
    expect(bigrams("ABAB")).toEqual(["AB", "BA"]);
    expect(bigrams("A")).toEqual(["A"]);
    expect(bigrams("")).toEqual([]);
  });

  it("shard は文字の並びで決まり、英字の bigram も離れた番号に分かれる", () => {
    // scripts/build-data.mjs の shardSql と同じ値 (コードポイントの和だと 146・159・163 に集まる)
    expect(["FL", "OP", "PS"].map((g) => shardOf(g, 8192))).toEqual([1054, 2237, 2371]);
    expect(shardOf("AB", 8192)).not.toBe(shardOf("BA", 8192));
    expect(shardOf("", 8192)).toBe(0);
  });

  it("編集距離は文字単位", () => {
    expect(levenshtein("クエリア", "クエリ")).toBe(1);
    expect(levenshtein("あいう", "あえう")).toBe(1);
    expect(levenshtein("", "abc")).toBe(3);
  });
});
