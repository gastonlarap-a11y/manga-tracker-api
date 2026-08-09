import { describe, expect, it } from "bun:test";
import { assertSafeOutDir, runtimeManifest } from "./package";

const ROOT = "/home/dev/manga-tracker-api";

describe("assertSafeOutDir", () => {
  it("accepts a build directory of its own", () => {
    expect(() => assertSafeOutDir("/tmp/package", ROOT)).not.toThrow();
    expect(() => assertSafeOutDir(`${ROOT}/build/out`, ROOT)).not.toThrow();
  });

  it("refuses to delete the repository", () => {
    // The output directory is removed before it is rebuilt, so a typo in --out
    // has to cost nothing.
    expect(() => assertSafeOutDir(ROOT, ROOT)).toThrow(/Refusing/);
    expect(() => assertSafeOutDir(".", ROOT)).toThrow(/Refusing/);
  });

  it("refuses a directory that contains the repository", () => {
    expect(() => assertSafeOutDir("/home/dev", ROOT)).toThrow(/Refusing/);
    expect(() => assertSafeOutDir("/", ROOT)).toThrow(/Refusing/);
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
