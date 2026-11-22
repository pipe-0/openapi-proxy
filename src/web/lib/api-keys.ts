import { queryOptions } from "@tanstack/react-query";
import { body, type KeyAccess, request } from "@/lib/api";

/** A key as it is listed: never the key itself, only what tells one from another. */
export interface ApiKey {
  id: string;
  name: string;
  /** The first characters of the key. */
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** "full": the API, the MCP endpoint and every private variant. "read": private variants only. */
  access: KeyAccess;
  /** For a key that only reads: the one variant it reads, or null for all of them. */
  variantId: string | null;
  /** Name of the person who made it, and whom it acts as. */
  createdBy: string;
  yours: boolean;
}

/** The answer to creating a key: the only time the key itself is sent. */
export interface CreatedKey extends ApiKey {
  key: string;
}

export const keysApi = {
  list: () => request<ApiKey[]>("/api/workspace/keys"),
  create: (key: { name: string; access: KeyAccess; variantId?: string | null }) =>
    request<CreatedKey>("/api/workspace/keys", body("POST", key)),
  revoke: (id: string) =>
    request<{ ok: boolean }>(`/api/workspace/keys/${id}`, { method: "DELETE" }),
};

export const keysQuery = queryOptions({ queryKey: ["api-keys"], queryFn: keysApi.list });
