import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { assertSafeOutDir, runtimeManifest } from "./package";

/**
 * Resolved rather than written as a POSIX literal: on Windows a bare
 * "/home/dev/..." is not the same string the guard computes, so the fixture
 * would quietly stop matching and the test would pass while proving nothing.
 */
const ROOT = resolve("/home/dev/manga-tracker-api");

describe("assertSafeOutDir", () => {
  it("accepts a build directory of its own", () => {
    expect(() => assertSafeOutDir(resolve("/tmp/package"), ROOT)).not.toThrow();
    expect(() =>
      assertSafeOutDir(resolve(ROOT, "build/out"), ROOT),
    ).not.toThrow();
  });

  it("refuses to delete the repository", () => {
    // The output directory is removed before it is rebuilt, so a typo in --out
    // has to cost nothing.
    expect(() => assertSafeOutDir(ROOT, ROOT)).toThrow(/Refusing/);
    expect(() => assertSafeOutDir(".", ROOT)).toThrow(/Refusing/);
  });

  it("refuses a directory that contains the repository", () => {
    // Containment is tested with `relative`, not a "/"-prefixed string: the
    // prefix version accepted C:\Users\you on Windows with the repo inside it.
    expect(() => assertSafeOutDir(resolve(ROOT, ".."), ROOT)).toThrow(
      /Refusing/,
    );
    expect(() => assertSafeOutDir(resolve("/"), ROOT)).toThrow(/Refusing/);
  });
});

describe("runtimeManifest", () => {
  it("declares only the native driver", () => {
    // Everything else is bundled. Listing more would reinstate the 360 MB tree
    // the bundle exists to avoid.
    const manifest = JSON.parse(runtimeManifest("^7.8.0"));

    expect(Object.keys(manifest.dependencies)).toEqual([
      "@prisma/adapter-libsql",
    ]);
  });

  it("carries the version it was given rather than one written by hand", () => {
    // A hardcoded version drifts the day the dependency is bumped, and the
    // failure surfaces as a native module mismatch at run time.
    expect(JSON.parse(runtimeManifest("^9.1.2")).dependencies).toEqual({
      "@prisma/adapter-libsql": "^9.1.2",
    });
  });

  it("is an ES module, like the code it has to load", () => {
    expect(JSON.parse(runtimeManifest("^7.8.0")).type).toBe("module");
  });
});
