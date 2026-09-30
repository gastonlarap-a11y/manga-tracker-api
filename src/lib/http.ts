import type { Hook } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import type { Env, ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";

export const errorSchema = z.object({ error: z.string() }).openapi("Error");
export type ErrorResponse = z.infer<typeof errorSchema>;

/**
 * Shared defaultHook for every module's OpenAPIHono instance: turns Zod
 * validation failures into a JSON 400 with the { error } shape used across
 * the whole API.
 */
export const defaultHook: Hook<unknown, Env, string, Response | undefined> = (
  result,
  c,
) => {
  if (!result.success) {
    const error = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return c.json({ error }, 400);
  }
  return undefined;
};

/**
 * The app-wide `onError`.
 *
 * An HTTPException is an answer someone decided on — the csrf guard's 403, the
 * body parser's 400 for JSON that does not parse — and it keeps its status.
 * Folding it into a 500 told a refused request that the server had crashed,
 * and logged a stack trace for what was never a fault. Everything else really
 * is one, and is logged as such.
 */
export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  console.error(`[Unhandled Error] ${err.message}`, err.stack);
  return c.json({ error: "Internal Server Error" }, 500);
};
