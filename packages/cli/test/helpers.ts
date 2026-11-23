import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
export const EXAMPLES = join(here, "../../../examples");
export const example = (name: string, file = "") => join(EXAMPLES, name, file);

/** A copy of an example folder that a test may write into. */
export function copyOf(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "openapi-proxy-test-"));
  cpSync(example(name), dir, { recursive: true });
  return dir;
}

/** Run something and collect what it printed. */
export async function captured<T>(
  run: () => Promise<T>,
): Promise<{ result: T; out: string; err: string }> {
  let out = "";
  let err = "";
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
  try {
    return { result: await run(), out, err };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}
