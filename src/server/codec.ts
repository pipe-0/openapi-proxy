import { Buffer } from "node:buffer";

/**
 * Documents are stored gzip-compressed and base64-encoded. OpenAPI JSON
 * compresses 10 to 20 times, which keeps multi-megabyte specs far below D1's
 * 2 MB row limit, and base64 text travels through D1 more compactly than a
 * BLOB (which the binding returns as a JSON array of numbers).
 */
export async function pack(text: string): Promise<string> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = await new Response(stream).arrayBuffer();
  return Buffer.from(bytes).toString("base64");
}

export async function unpack(packed: string): Promise<string> {
  const bytes = Buffer.from(packed, "base64");
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/** D1 rejects rows over 2 MB; stay clear of it. */
export const MAX_PACKED_LENGTH = 1_900_000;

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(digest).toString("hex");
}
