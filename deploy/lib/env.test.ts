import { describe, expect, it } from "bun:test";
import {
  ENV_MANIFEST,
  envValues,
  parseEnvFile,
  resolveSpec,
  secretSpecs,
  serializeEnvFile,
  serializeValue,
  upsertEntry,
} from "./env";

const specFor = (name: string) => {
  const spec = ENV_MANIFEST.find((candidate) => candidate.name === name);
  if (spec === undefined) {
    throw new Error(`no spec for ${name}`);
  }
  return spec;
};

describe("manifest", () => {
  it("treats only the connection string as a shared secret", () => {
    expect(secretSpecs().map((spec) => spec.name)).toEqual(["MONGODB_URL"]);
  });

  it("keeps the secret name the credential bootstrap already uses", () => {
    // Renaming this orphans the secret already stored in the vault.
    expect(secretSpecs()[0]?.secretName).toBe("mangatracker-mongodb-url");
  });

  it("points dev and prod at different databases, in both stores", () => {
    const secrets = new Map<string, string>();
    const home = "/Users/someone";

    expect(
      resolveSpec(specFor("DATABASE_URL"), "dev", home, secrets, "darwin"),
    ).toBe("file:./dev.db");
    expect(
      resolveSpec(specFor("DATABASE_URL"), "prod", home, secrets, "darwin"),
    ).toBe(
      `file:${home}/Library/Application Support/MangaTracker/mangatracker.db`,
    );
    expect(resolveSpec(specFor("MONGODB_DB"), "dev", home, secrets)).toBe(
      "mangatracker_dev",
    );
    expect(resolveSpec(specFor("MONGODB_DB"), "prod", home, secrets)).toBe(
      "mangatracker",
    );
  });

  it("defaults the platform to this process, so existing call sites still resolve macOS", () => {
    const secrets = new Map<string, string>();
    const home = "/Users/someone";

    // This suite only runs on macOS/Linux CI, so the default lands on the
    // non-Windows branch either way — asserting against `darwin`'s value
    // documents that the parameter is optional, not that it always resolves
    // to darwin specifically.
    expect(resolveSpec(specFor("DATABASE_URL"), "dev", home, secrets)).toBe(
      "file:./dev.db",
    );
  });

  it("resolves DATABASE_URL under %LOCALAPPDATA% on Windows, with forward slashes", () => {
    const secrets = new Map<string, string>();
    const home = "C:\\Users\\someone";

    expect(
      resolveSpec(specFor("DATABASE_URL"), "prod", home, secrets, "win32"),
    ).toBe("file:C:/Users/someone/AppData/Local/MangaTracker/mangatracker.db");
    expect(
      resolveSpec(specFor("DATABASE_URL"), "dev", home, secrets, "win32"),
    ).toBe("file:./dev.db");
  });

  it("reports a secret as unresolved rather than inventing a value", () => {
    expect(
      resolveSpec(specFor("MONGODB_URL"), "prod", "/Users/someone", new Map()),
    ).toBeNull();
  });
});

describe("serializeValue", () => {
  // Verified against Bun directly: it expands `$` in unquoted, single-quoted
  // and double-quoted values alike, so escaping is the only defence.
  it("escapes $ so a password is not expanded away", () => {
    expect(serializeValue("MONGODB_URL", "p$ssword")).toBe('"p\\$ssword"');
  });

  it("quotes so an unquoted # does not truncate the value", () => {
    expect(serializeValue("X", "a#b")).toBe('"a#b"');
  });

  it("refuses values Bun cannot read back instead of corrupting them", () => {
    // Bun leaves the backslash in place for \" and \\, so these cannot survive
    // a round trip. Failing loudly beats writing a broken credential.
    expect(() => serializeValue("X", 'has"quote')).toThrow(
      /quote or backslash/,
    );
    expect(() => serializeValue("X", "has\\slash")).toThrow(
      /quote or backslash/,
    );
  });
});

describe("parseEnvFile", () => {
  it("round-trips a value through serialize and parse", () => {
    const value = "mongodb+srv://u:p$ss%23w@host/db?tls=true&retryWrites=false";
    const text = serializeEnvFile([
      { kind: "entry", key: "MONGODB_URL", value },
    ]);
    expect(envValues(parseEnvFile(text)).get("MONGODB_URL")).toBe(value);
  });

  it("reads unquoted, quoted and exported forms", () => {
    const values = envValues(
      parseEnvFile(
        ["A=plain", 'B="quoted value"', "C='single'", "export D=exported"].join(
          "\n",
        ),
      ),
    );
    expect(values.get("A")).toBe("plain");
    expect(values.get("B")).toBe("quoted value");
    expect(values.get("C")).toBe("single");
    expect(values.get("D")).toBe("exported");
  });

  it("drops a trailing comment from an unquoted value, like Bun does", () => {
    expect(envValues(parseEnvFile("A=value # note")).get("A")).toBe("value");
  });

  it("treats a missing file as no lines at all", () => {
    // A file built from nothing must not open with stray blank lines.
    expect(parseEnvFile("")).toEqual([]);
  });

  it("keeps comments and blank lines as-is", () => {
    const text = "# a note\n\nA=1\n";
    expect(serializeEnvFile(parseEnvFile(text))).toBe('# a note\n\nA="1"\n');
  });
});

describe("upsertEntry", () => {
  it("replaces a variable in place, keeping its position", () => {
    const lines = parseEnvFile("FIRST=1\nMONGODB_DB=old\nLAST=3\n");
    const updated = upsertEntry(lines, specFor("MONGODB_DB"), "new");
    expect([...envValues(updated).keys()]).toEqual([
      "FIRST",
      "MONGODB_DB",
      "LAST",
    ]);
    expect(envValues(updated).get("MONGODB_DB")).toBe("new");
  });

  it("appends with its comment when the variable is absent", () => {
    const updated = upsertEntry(
      parseEnvFile("FIRST=1\n"),
      specFor("PORT"),
      "5150",
    );
    expect(serializeEnvFile(updated)).toContain(
      "# Dev and prod share the port",
    );
    expect(envValues(updated).get("PORT")).toBe("5150");
  });

  it("starts a brand-new file with the comment, not a blank line", () => {
    const created = serializeEnvFile(
      upsertEntry(parseEnvFile(""), specFor("PORT"), "5150"),
    );
    expect(created.startsWith("# ")).toBe(true);
  });

  it("never drops a variable the manifest does not know about", () => {
    // A pull rewrites .env; anything added by hand has to survive it.
    const lines = parseEnvFile("SOMETHING_CUSTOM=keep-me\n");
    const updated = upsertEntry(lines, specFor("PORT"), "5150");
    expect(envValues(updated).get("SOMETHING_CUSTOM")).toBe("keep-me");
  });
});
