import type { z } from "zod";

export function stripFences(stdout: string): string {
  return stdout
    .trim()
    .replace(/^```(?:json|text)?\s*/i, "")
    .replace(/\s*```$/, "");
}

export function parseJsonOutput<T>(stdout: string, what: string, schema: z.ZodType<T>): T {
  const raw = stripFences(stdout);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`${what} output is not JSON: ${JSON.stringify(raw.slice(0, 120))}`);
  }
  return schema.parse(json);
}
