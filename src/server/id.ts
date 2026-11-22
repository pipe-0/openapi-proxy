const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** A short random identifier with a readable prefix, e.g. `prj_k2j8x0q1m4zt`. */
export function newId(prefix: "prj" | "var" | "src"): string {
  return `${prefix}_${randomToken(12)}`;
}

/** Lower-case alphanumeric token. Fine for ids and slugs; not for secrets. */
export function randomToken(length: number): string {
  let token = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
    token += ALPHABET[byte % ALPHABET.length];
  }
  return token;
}
