import { queryOptions } from "@tanstack/react-query";
import { body, request } from "@/lib/api";

/** A token as it is listed: never the token itself, only what tells one from another. */
export interface ApiToken {
  id: string;
  name: string;
  /** The first characters of the token. */
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** Name of the person who made it, and whom it acts as. */
  createdBy: string;
  yours: boolean;
}

/** The answer to creating a token: the only time the token itself is sent. */
export interface CreatedToken extends ApiToken {
  token: string;
}

export const tokensApi = {
  list: () => request<ApiToken[]>("/api/workspace/tokens"),
  create: (name: string) => request<CreatedToken>("/api/workspace/tokens", body("POST", { name })),
  revoke: (id: string) =>
    request<{ ok: boolean }>(`/api/workspace/tokens/${id}`, { method: "DELETE" }),
};

export const tokensQuery = queryOptions({ queryKey: ["api-tokens"], queryFn: tokensApi.list });
