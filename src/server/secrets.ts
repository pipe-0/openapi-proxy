import { Buffer } from "node:buffer";
import type { StoredHeader } from "./db/schema";

/**
 * Request headers for a project's source (an API key, a bearer token) are
 * secrets belonging to whoever owns that API. They are encrypted before they
 * reach the database, with a key derived from AUTH_SECRET, and are never
 * returned by the admin API: the UI only ever sees header names.
 */
const KEY_INFO = "openapi-proxy/source-headers/v1";
const encoder = new TextEncoder();

async function deriveKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode(KEY_INFO) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt one header value. The header name is bound in as associated data. */
async function seal(key: CryptoKey, name: string, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(name.toLowerCase()) },
    key,
    encoder.encode(value),
  );
  return `v1.${Buffer.from(iv).toString("base64url")}.${Buffer.from(ciphertext).toString("base64url")}`;
}

async function open(key: CryptoKey, name: string, sealed: string): Promise<string> {
  const [version, iv, ciphertext] = sealed.split(".");
  if (version !== "v1" || !iv || !ciphertext) throw new Error("unknown format");
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Buffer.from(iv, "base64url"),
      additionalData: encoder.encode(name.toLowerCase()),
    },
    key,
    Buffer.from(ciphertext, "base64url"),
  );
  return new TextDecoder().decode(plaintext);
}

export class HeaderSecretError extends Error {}

export async function sealHeaders(
  secret: string,
  headers: Array<{ name: string; value: string }>,
): Promise<StoredHeader[]> {
  const key = await deriveKey(secret);
  return Promise.all(
    headers.map(async ({ name, value }) => ({ name, value: await seal(key, name, value) })),
  );
}

export async function openHeaders(
  secret: string | undefined,
  stored: StoredHeader[],
): Promise<Record<string, string>> {
  if (stored.length === 0) return {};
  if (!secret) throw new HeaderSecretError("AUTH_SECRET is not set.");
  const key = await deriveKey(secret);
  const headers: Record<string, string> = {};
  try {
    for (const { name, value } of stored) headers[name] = await open(key, name, value);
  } catch {
    throw new HeaderSecretError(
      "The stored request headers could not be decrypted. If AUTH_SECRET changed, enter them again.",
    );
  }
  return headers;
}

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
/** Headers the proxy sets itself, or that make no sense on an outbound fetch. */
const RESERVED = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "if-none-match",
  "if-modified-since",
  "accept-encoding",
]);

export const MAX_SOURCE_HEADERS = 10;

/** Why a header from user input is unacceptable, or undefined when it is fine. */
export function headerProblem(name: string, value: string | undefined): string | undefined {
  if (!HEADER_NAME.test(name)) return `"${name}" is not a valid header name.`;
  if (RESERVED.has(name.toLowerCase())) return `The ${name} header is set by the proxy.`;
  if (value !== undefined && (value === "" || value.length > 4000 || /[\r\n\0]/.test(value))) {
    return `The value for ${name} must be a single line of 1 to 4000 characters.`;
  }
  return undefined;
}
