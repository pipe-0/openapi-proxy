import { isJsonObject, type JsonObject, type OpenAPIDocument } from "../types.js";

/** One place an API can be reached, as OpenAPI lists them under `servers`. */
export interface ServerOverride {
  url: string;
  /** What this one is: "Production", "Sandbox". */
  description?: string;
}

/**
 * What a variant says at the top of its document instead of what the source
 * says: how the API is called, how it is described, and where it lives.
 * Anything left out is the document's own.
 *
 * This is what an environment comes to. The operations of an API are the same
 * in production, in a sandbox and on staging; what differs is where requests
 * go, and that is the `servers` list, in which the first entry is the one
 * tools take when nobody chooses. A variant for another audience can list
 * other servers (a public one leaves the internal ones out), and one for
 * another environment can put that environment first.
 */
export interface DocumentOverrides {
  title?: string;
  description?: string;
  servers?: ServerOverride[];
}

export const OVERRIDE_LIMITS = { title: 200, description: 5_000, servers: 20, url: 2_000 };

const SERVER_URL = /^(?:https?:\/\/|\/)[^\s{}]*$/;

/**
 * Read overrides from untrusted input. Gives the overrides, `null` for
 * "none" (nothing set, or everything empty), or a sentence saying what is
 * wrong.
 */
export function readOverrides(input: unknown): DocumentOverrides | null | { problem: string } {
  if (input === null || input === undefined) return null;
  if (!isJsonObject(input)) return { problem: "overrides must be an object or null." };
  const out: DocumentOverrides = {};

  for (const field of ["title", "description"] as const) {
    const value = input[field];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string" || value.length > OVERRIDE_LIMITS[field]) {
      return { problem: `${field} must be text of up to ${OVERRIDE_LIMITS[field]} characters.` };
    }
    if (value.trim() !== "") out[field] = field === "title" ? value.trim() : value;
  }

  const servers = input.servers;
  if (servers !== undefined && servers !== null) {
    if (!Array.isArray(servers) || servers.length > OVERRIDE_LIMITS.servers) {
      return { problem: `servers must be a list of up to ${OVERRIDE_LIMITS.servers} entries.` };
    }
    const list: ServerOverride[] = [];
    for (const server of servers) {
      const url = isJsonObject(server) && typeof server.url === "string" ? server.url.trim() : "";
      if (url.length > OVERRIDE_LIMITS.url || !SERVER_URL.test(url)) {
        return {
          problem:
            "A server needs a URL that starts with https://, http:// or /, without spaces or {variables}.",
        };
      }
      const description = (server as JsonObject).description;
      if (description !== undefined && description !== null && typeof description !== "string") {
        return { problem: "A server's description must be text." };
      }
      const said = typeof description === "string" ? description.trim().slice(0, 200) : "";
      list.push(said === "" ? { url } : { url, description: said });
    }
    if (list.length > 0) out.servers = list;
  }

  return Object.keys(out).length === 0 ? null : out;
}

/**
 * The document with the overrides in place. Keys keep their position; a
 * `servers` list the document did not have goes after `info`, where people
 * look for it.
 */
export function applyOverrides(
  doc: OpenAPIDocument,
  overrides: DocumentOverrides | null | undefined,
): OpenAPIDocument {
  if (!overrides) return doc;
  const { title, description, servers } = overrides;
  if (title === undefined && description === undefined && servers === undefined) return doc;

  const out: OpenAPIDocument = {};
  const list = servers?.map((server) => ({ ...server }));
  for (const key of Object.keys(doc)) {
    if (key === "info") {
      out.info = {
        ...(isJsonObject(doc.info) ? doc.info : {}),
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
      };
      if (list && !Object.hasOwn(doc, "servers")) out.servers = list;
    } else if (key === "servers" && list) {
      out.servers = list;
    } else {
      out[key] = doc[key];
    }
  }
  if (list && !Object.hasOwn(out, "servers")) out.servers = list;
  return out;
}
