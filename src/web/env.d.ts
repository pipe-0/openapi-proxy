/**
 * The Worker's variables, as server-side code of the web app reads them
 * (`src/web/site/site.functions.ts`). The full list with types lives in
 * `src/server/env.ts`.
 */
declare module "cloudflare:workers" {
  export const env: Record<string, string | undefined>;
}
