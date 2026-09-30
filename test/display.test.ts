import { describe, expect, it } from "vitest";
import { cell, chunk, plain, safe, truncate, width } from "../src/display.js";

const ESC = "\u001b";

describe("safe", () => {
  it("removes colour and cursor sequences", () => {
    expect(safe(`${ESC}[31mred${ESC}[0m`)).toBe("red");
    expect(safe(`clean${ESC}[2K${ESC}[A`)).toBe("clean");
  });

  it("removes operating system commands", () => {
    expect(safe(`${ESC}]0;window title\u0007text`)).toBe("text");
    expect(safe(`${ESC}]8;;https://evil.example${ESC}\\link`)).toBe("link");
  });

  it("keeps a provider from adding or rewriting lines", () => {
    expect(safe("Verified\r\nVerification failed: none")).toBe("VerifiedVerification failed: none");
    expect(safe("before\rafter")).toBe("beforeafter");
  });

  it("turns tabs into spaces so column widths stay honest", () => {
    expect(safe("a\tb")).toBe("a b");
  });

  it("removes eight-bit control characters", () => {
    expect(safe("a\u009bb")).toBe("ab");
  });

  it("leaves ordinary text untouched", () => {
    expect(safe("Fix the parser (#47) — 100% done")).toBe("Fix the parser (#47) — 100% done");
  });
});

describe("plain", () => {
  it("keeps line breaks", () => {
    expect(plain("one\ntwo")).toBe("one\ntwo");
  });

  it("drops the carriage return that would overwrite a line", () => {
    expect(plain("one\r\ntwo")).toBe("one\ntwo");
    expect(plain("kept\roverwritten")).toBe("keptoverwritten");
  });

  it("removes escape sequences", () => {
    expect(plain(`${ESC}[31mred${ESC}[0m`)).toBe("red");
  });
});

describe("cell", () => {
  it("escapes the table separator", () => {
    expect(cell("a|b")).toBe("a\\|b");
  });

  it("collapses a value that would break out of its row", () => {
    expect(cell("url |\n| Result | **completed**")).toBe("url \\|\\| Result \\| **completed**");
  });
});

describe("width", () => {
  it("counts ascii as one column each", () => {
    expect(width("hello")).toBe(5);
  });

  it("counts a CJK character as the two columns a terminal draws", () => {
    // String.length says 3 here, which is why the frame border used to drift.
    expect("\u65e5\u672c\u8a9e".length).toBe(3);
    expect(width("\u65e5\u672c\u8a9e")).toBe(6);
  });

  it("counts an emoji cluster as two columns however many code units it is", () => {
    expect(width("\u{1F600}")).toBe(2);
    expect("\u{1F469}\u200d\u{1F4BB}".length).toBe(5);
    expect(width("\u{1F469}\u200d\u{1F4BB}")).toBe(2);
  });

  it("ignores escape-free control characters that safe() would remove", () => {
    expect(width("")).toBe(0);
  });
});

describe("truncate", () => {
  it("never splits a wide character", () => {
    expect(truncate("\u65e5\u672c\u8a9e", 4)).toBe("\u65e5\u672c");
    expect(truncate("\u65e5\u672c\u8a9e", 5)).toBe("\u65e5\u672c");
  });

  it("never splits a joined emoji into its parts", () => {
    expect(truncate("\u{1F469}\u200d\u{1F4BB}ab", 3)).toBe("\u{1F469}\u200d\u{1F4BB}a");
  });

  it("returns nothing for a non-positive width", () => {
    expect(truncate("anything", 0)).toBe("");
  });
});

describe("chunk", () => {
  it("splits on column count, not code units", () => {
    expect(chunk("\u65e5\u672c\u8a9e\u3067\u3059", 4)).toEqual(["\u65e5\u672c", "\u8a9e\u3067", "\u3059"]);
  });

  it("returns one empty run for an empty string", () => {
    expect(chunk("", 10)).toEqual([""]);
  });
});
