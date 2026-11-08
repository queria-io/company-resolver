import { describe, expect, it } from "vitest";

import {
  bigrams,
  compareCodePoints,
  coreName,
  legalForm,
  levenshtein,
  nfkc,
  shardOf,
} from "../src/normalize";

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

  it("ファイル番号はコードポイントの和の余り", () => {
    expect(shardOf("AB", 256)).toBe((65 + 66) % 256);
  });

  it("編集距離は文字単位", () => {
    expect(levenshtein("クエリア", "クエリ")).toBe(1);
    expect(levenshtein("あいう", "あえう")).toBe(1);
    expect(levenshtein("", "abc")).toBe(3);
  });

  it("文字列はコードポイント順に比べる (Parquet の統計と同じ順)", () => {
    // U+FA11 (﨑) は UTF-16 ではサロゲートペアの 𠮷 (U+20BB7) より後ろだが、コードポイント順では前
    expect(compareCodePoints("山﨑", "山𠮷")).toBeLessThan(0);
    expect(compareCodePoints("AB", "AB")).toBe(0);
    expect(compareCodePoints("A", "AB")).toBeLessThan(0);
  });
});
