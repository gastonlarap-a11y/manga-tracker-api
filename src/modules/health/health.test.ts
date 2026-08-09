import { describe, expect, it } from "bun:test";
import { healthRoutes } from "./health.routes";

describe("GET /health", () => {
  // The exact body is the contract, not just the 200: a client that probes a
  // range of ports identifies this backend by `service`, so renaming the field
  // or its value breaks discovery on every installed machine.
  it("responds ok and names itself", async () => {
    const res = await healthRoutes.request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: "ok",
      service: "manga-tracker-api",
    });
  });
});
