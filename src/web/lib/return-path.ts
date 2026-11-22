/** Where the app opens when nothing more specific was asked for. */
export const APP_HOME = "/app";

/**
 * Where to go after signing in. Only same-site paths are accepted, so a
 * crafted link cannot bounce a fresh session to another origin.
 */
export function safeReturnPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return undefined;
  if (value.startsWith("/login")) return undefined;
  return value;
}
