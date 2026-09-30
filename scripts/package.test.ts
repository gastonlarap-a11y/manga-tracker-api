import { describe, expect, it } from "bun:test";
import { join, resolve } from "node:path";
import {
  assertRuntimeMatchesRepo,
  assertSafeOutDir,
  lockedVersion,
  NATIVE_DRIVER_PACKAGES,
  runtimeDir,
} from "./package";

const repoRoot = resolve(import.meta.dir, "..");

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

describe("the committed runtime", () => {
  const manifest = async () =>
    await Bun.file(join(runtimeDir, "package.json")).json();

  it("declares only the native driver", async () => {
    // Everything else is bundled. Listing more would reinstate the 360 MB tree
    // the bundle exists to avoid.
    expect(Object.keys((await manifest()).dependencies)).toEqual([
      "@prisma/adapter-libsql",
    ]);
  });

  it("pins it exactly, so a rebuild resolves the same tree", async () => {
    expect((await manifest()).dependencies["@prisma/adapter-libsql"]).toMatch(
      /^\d+\.\d+\.\d+$/,
    );
  });

  it("is an ES module, like the code it has to load", async () => {
    expect((await manifest()).type).toBe("module");
  });

  it("resolves the driver exactly as this repository does", async () => {
    // The drift this guards against: bumping the adapter here and forgetting
    // runtime/, which would ship a driver the tests never ran against.
    const [repoLock, runtimeLock] = await Promise.all([
      Bun.file(join(repoRoot, "bun.lock")).text(),
      Bun.file(join(runtimeDir, "bun.lock")).text(),
    ]);

    expect(() => assertRuntimeMatchesRepo(repoLock, runtimeLock)).not.toThrow();
  });

  it("records the native package of both platforms a release targets", async () => {
    const runtimeLock = await Bun.file(join(runtimeDir, "bun.lock")).text();

    expect(lockedVersion(runtimeLock, "@libsql/darwin-arm64")).not.toBeNull();
    expect(lockedVersion(runtimeLock, "@libsql/win32-x64-msvc")).not.toBeNull();
  });
});

describe("assertRuntimeMatchesRepo", () => {
  const lock = (version: string) =>
    NATIVE_DRIVER_PACKAGES.map(
      (name) => `    "${name}": ["${name}@${version}", "", {}, "sha512-x"],`,
    ).join("\n");

  it("refuses a runtime lock that has drifted", () => {
    expect(() =>
      assertRuntimeMatchesRepo(lock("7.9.0"), lock("7.8.0")),
    ).toThrow(/runtime\/bun.lock/);
  });

  it("accepts one that matches", () => {
    expect(() =>
      assertRuntimeMatchesRepo(lock("7.8.0"), lock("7.8.0")),
    ).not.toThrow();
  });
});
