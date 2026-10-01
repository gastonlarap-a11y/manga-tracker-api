import { describe, expect, it } from "bun:test";
import { searchKeyOf } from "./search-key";

describe("searchKeyOf", () => {
  it("lowercases and strips accents, so either spelling finds the other", () => {
    expect(searchKeyOf("Invocación del Dragón")).toBe("invocacion del dragon");
    expect(searchKeyOf("ÁSURA")).toBe(searchKeyOf("asura"));
  });

  it("keeps characters that are not accents", () => {
    expect(searchKeyOf("¡Yo, El Señor!")).toBe("¡yo, el senor!");
  });
});
