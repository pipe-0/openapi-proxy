/**
 * Who may read, and what a key may do. Shared by the server, which enforces
 * both, and the app, which offers them.
 */

// Who may read what a variant serves is part of the definition format.
export { isVisibility, type Visibility } from "@openapi-proxy/core";

/**
 * The two kinds of API key, by what they may do.
 *
 * "deploy": apply a definition to a project, and nothing else. It belongs to
 * the workspace, and only its owner makes and revokes such keys.
 *
 * "read": read private variants and nothing else, all of the workspace's or
 * one. It belongs to the person who made it.
 */
export type KeyAccess = "deploy" | "read";

export function isKeyAccess(value: unknown): value is KeyAccess {
  return value === "deploy" || value === "read";
}
