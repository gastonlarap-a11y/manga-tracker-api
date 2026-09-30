import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { errorHandler } from "./http";

describe("errorHandler", () => {
  it("keeps the status of an answer someone decided on", async () => {
    const app = new Hono().onError(errorHandler).get("/", () => {
      throw new HTTPException(400, {
        message: "Malformed JSON in request body",
      });
    });

    const res = await app.request("/");

    expect(res.status).toBe(400);
  });

  it("reports anything else as the fault it is", async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const app = new Hono().onError(errorHandler).get("/", () => {
        throw new Error("boom");
      });

      const res = await app.request("/");

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Internal Server Error" });
    } finally {
      console.error = original;
    }
  });
});
