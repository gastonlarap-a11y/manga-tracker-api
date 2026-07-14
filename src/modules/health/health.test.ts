import { describe, expect, it } from "bun:test";
import { healthRoutes } from "./health.routes";

describe("GET /health", () => {
  it("responds with status ok", async () => {
    const res = await healthRoutes.request("/health");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
