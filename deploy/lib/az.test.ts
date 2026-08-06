import { describe, expect, it } from "bun:test";
import {
  assignSecretsOfficer,
  createVault,
  getSecret,
  isVaultNameAvailable,
  SECRETS_OFFICER_ROLE_ID,
} from "./az";
import { secretSpecs } from "./env";
import { macosAdapter } from "./platform";
import { createFakeRunner } from "./run";
import { pushSecret, resolveSecret } from "./secrets";

const SPEC = secretSpecs()[0];
if (SPEC === undefined) {
  throw new Error("the manifest must declare at least one secret");
}

const VAULT = "kv-test";
const SCOPE = `/subscriptions/s/resourcegroups/rg/providers/Microsoft.KeyVault/vaults/${VAULT}`;

/** Every step of the cascade answers "nothing here" unless a test overrides it. */
const emptyMachine = [
  { when: ["plutil", "-extract"], code: 1 },
  { when: ["security", "find-generic-password"], code: 1 },
  { when: ["security", "add-generic-password"] },
  { when: ["which", "az"] },
] as const;

describe("createVault", () => {
  it("requests RBAC and the shortest retention, and never purge protection", () => {
    const fake = createFakeRunner([
      { when: ["az", "keyvault", "create"], stdout: SCOPE },
    ]);
    return createVault(fake.run, {
      vault: VAULT,
      resourceGroup: "rg",
      location: "brazilsouth",
    }).then(() => {
      const command = fake.calls[0]?.join(" ") ?? "";
      expect(command).toContain("--enable-rbac-authorization true");
      expect(command).toContain("--retention-days 7");
      // Purge protection is irreversible; enabling it by accident would lock
      // the vault for 90 days.
      expect(command).not.toContain("purge-protection");
    });
  });
});

describe("assignSecretsOfficer", () => {
  it("assigns by role ID and object ID", async () => {
    const fake = createFakeRunner([
      { when: ["az", "role", "assignment", "create"] },
    ]);
    const { created } = await assignSecretsOfficer(fake.run, SCOPE, "obj-1");

    const command = fake.calls[0]?.join(" ") ?? "";
    // The ID survives a role rename; the name would not.
    expect(command).toContain(`--role ${SECRETS_OFFICER_ROLE_ID}`);
    // Object ID + principal type skips a Graph lookup that misresolves for
    // accounts that are guests in their own tenant.
    expect(command).toContain("--assignee-object-id obj-1");
    expect(command).toContain("--assignee-principal-type User");
    expect(created).toBe(true);
  });

  it("treats an existing assignment as success, so provisioning is idempotent", async () => {
    const fake = createFakeRunner([
      {
        when: ["az", "role", "assignment", "create"],
        code: 1,
        stderr: "(RoleAssignmentExists) The role assignment already exists.",
      },
    ]);
    expect(await assignSecretsOfficer(fake.run, SCOPE, "obj-1")).toEqual({
      created: false,
    });
  });

  it("still fails on a real authorization error", async () => {
    const fake = createFakeRunner([
      {
        when: ["az", "role", "assignment", "create"],
        code: 1,
        stderr: "(AuthorizationFailed) does not have permission",
      },
    ]);
    expect(assignSecretsOfficer(fake.run, SCOPE, "obj-1")).rejects.toThrow(
      /AuthorizationFailed/,
    );
  });
});

describe("getSecret", () => {
  it("returns null for a secret that was never uploaded", async () => {
    const fake = createFakeRunner([
      {
        when: ["az", "keyvault", "secret", "show"],
        code: 1,
        stderr: "(SecretNotFound) A secret with (name/id) x was not found",
      },
    ]);
    expect(await getSecret(fake.run, VAULT, "x")).toBeNull();
  });

  it("distinguishes a missing secret from a denied read", async () => {
    // Swallowing a 403 here would make a permissions problem look like an
    // empty vault, and the caller would happily overwrite it.
    const fake = createFakeRunner([
      {
        when: ["az", "keyvault", "secret", "show"],
        code: 1,
        stderr: "(Forbidden) Caller is not authorized",
      },
    ]);
    expect(getSecret(fake.run, VAULT, "x")).rejects.toThrow(/Forbidden/);
  });
});

describe("isVaultNameAvailable", () => {
  it("reads the availability flag", async () => {
    const taken = createFakeRunner([
      { when: ["az", "keyvault", "check-name"], stdout: "false" },
    ]);
    expect(await isVaultNameAvailable(taken.run, VAULT)).toBe(false);
  });
});

describe("resolveSecret", () => {
  it("prefers the plist and never reaches the network", async () => {
    const fake = createFakeRunner([
      { when: ["plutil", "-extract"], stdout: "from-plist" },
      { when: ["security", "add-generic-password"] },
    ]);
    const resolved = await resolveSecret(fake.run, SPEC, {
      vault: VAULT,
      platform: macosAdapter,
    });

    expect(resolved).toEqual({ value: "from-plist", from: "config" });
    expect(fake.calls.some((call) => call[0] === "az")).toBe(false);
  });

  it("falls back to the Keychain before Azure", async () => {
    const fake = createFakeRunner([
      { when: ["plutil", "-extract"], code: 1 },
      { when: ["security", "find-generic-password"], stdout: "from-keychain" },
    ]);
    const resolved = await resolveSecret(fake.run, SPEC, {
      vault: VAULT,
      platform: macosAdapter,
    });

    expect(resolved).toEqual({ value: "from-keychain", from: "cache" });
    expect(fake.calls.some((call) => call[0] === "az")).toBe(false);
  });

  it("recovers from Key Vault and caches it locally", async () => {
    const fake = createFakeRunner([
      ...emptyMachine,
      { when: ["az", "keyvault", "secret", "show"], stdout: '"from-vault"' },
    ]);
    const resolved = await resolveSecret(fake.run, SPEC, {
      vault: VAULT,
      platform: macosAdapter,
    });

    expect(resolved).toEqual({ value: "from-vault", from: "keyvault" });
    // Caching is what makes the next run work offline.
    expect(
      fake.calls.some(
        (call) => call[0] === "security" && call[1] === "add-generic-password",
      ),
    ).toBe(true);
  });

  it("gives up cleanly when the Azure CLI is missing", async () => {
    const fake = createFakeRunner([
      { when: ["plutil", "-extract"], code: 1 },
      { when: ["security", "find-generic-password"], code: 1 },
      { when: ["which", "az"], code: 1 },
    ]);
    expect(
      await resolveSecret(fake.run, SPEC, {
        vault: VAULT,
        platform: macosAdapter,
      }),
    ).toBeNull();
  });
});

describe("pushSecret", () => {
  it("does not create a new version when the value already matches", async () => {
    const fake = createFakeRunner([
      { when: ["az", "keyvault", "secret", "show"], stdout: '"same"' },
    ]);
    expect(await pushSecret(fake.run, VAULT, SPEC, "same")).toBe("unchanged");
    expect(fake.calls.some((call) => call[3] === "set")).toBe(false);
  });

  it("keeps the secret out of argv, where ps would show it", async () => {
    const fake = createFakeRunner([
      {
        when: ["az", "keyvault", "secret", "show"],
        code: 1,
        stderr: "SecretNotFound",
      },
      { when: ["az", "keyvault", "secret", "set"] },
    ]);
    expect(await pushSecret(fake.run, VAULT, SPEC, "s3cr3t")).toBe("created");

    const setCall = fake.calls.find((call) => call[3] === "set") ?? [];
    expect(setCall).toContain("--file");
    expect(setCall).not.toContain("s3cr3t");
  });
});
