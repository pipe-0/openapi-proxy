import { queryOptions } from "@tanstack/react-query";
import { body, type KeyAccess, request } from "@/lib/api";

/** The one variant a user API key reads, by where it is served. */
export interface KeyVariant {
  project: string;
  variant: string;
}

/** A key as it is listed: never the key itself, only what tells one from another. */
export interface ApiKey {
  id: string;
  name: string;
  /** The first characters of the key. */
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** "deploy": applies definitions, for a pipeline. "read": reads private variants. */
  access: KeyAccess;
  /** For a user API key: the one variant it reads, or null for all of them. */
  variant: KeyVariant | null;
  /** Name of the person who made it. A user API key acts for them. */
  createdBy: string | null;
  yours: boolean;
}

/** The answer to creating a key: the only time the key itself is sent. */
export interface CreatedKey extends ApiKey {
  key: string;
}

export type NewKey =
  | { name: string; access: "deploy" }
  | { name: string; access: "read"; variant: KeyVariant | null };

export const keysApi = {
  list: () => request<ApiKey[]>("/api/workspace/keys"),
  create: (key: NewKey) => request<CreatedKey>("/api/workspace/keys", body("POST", key)),
  revoke: (id: string) =>
    request<{ ok: boolean }>(`/api/workspace/keys/${id}`, { method: "DELETE" }),
};

export const keysQuery = queryOptions({ queryKey: ["api-keys"], queryFn: keysApi.list });
