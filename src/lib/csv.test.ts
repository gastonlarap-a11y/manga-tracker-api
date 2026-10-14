import { describe, expect, it } from "bun:test";
import { csvField, csvRecord } from "./csv";

describe("csvField", () => {
  it.each([
    ["a plain title as it is", "Berserk", "Berserk"],
    ["accents untouched", "Ásura: el regreso", "Ásura: el regreso"],
    ["a comma inside quotes", "Hola, mundo", '"Hola, mundo"'],
    ["inner quotes doubled", 'El "rey"', '"El ""rey"""'],
    ["a line break inside quotes", "uno\ndos", '"uno\ndos"'],
    ["a formula made text", "=HYPERLINK(1)", "'=HYPERLINK(1)"],
    ["a plus made text", "+1", "'+1"],
    ["a minus made text", "-1", "'-1"],
    ["an at sign made text", "@cmd", "'@cmd"],
    ["a leading tab made text", "\tx", "'\tx"],
    ["a leading CR made text, then quoted", "\rx", '"\'\rx"'],
    [
      "a formula with a comma both neutralised and quoted",
      "=A1,B1",
      '"\'=A1,B1"',
    ],
    ["an empty field empty", "", ""],
    ["a dash later in the text untouched", "Re-Zero", "Re-Zero"],
  ])("writes %s", (_case, input, expected) => {
    expect(csvField(input)).toBe(expected);
  });
});

describe("csvRecord", () => {
  it("joins the fields with commas and ends the record with CRLF", () => {
    expect(csvRecord(["a", "b,c", ""])).toBe('a,"b,c",\r\n');
  });
});
