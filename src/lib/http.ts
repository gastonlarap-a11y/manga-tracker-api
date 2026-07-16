import type { Hook } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import type { Env } from "hono";

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
