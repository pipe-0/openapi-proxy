/**
 * Who may read, and what a key may do. Shared by the server, which enforces
 * both, and the app, which offers them.
 */

// Who may read what a variant serves is part of the definition format.
export { isVisibility, type Visibility } from "@openapi-proxy/core";

/**
 * What an API key may do. "full": everything a key can, which is the API, the
 * MCP endpoint and reading every private variant. "read": reading private
 * variants and nothing else, all of the workspace's or one.
 */
export type KeyAccess = "full" | "read";

export function isKeyAccess(value: unknown): value is KeyAccess {
  return value === "full" || value === "read";
}
