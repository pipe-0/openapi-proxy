import type { D1Migration } from "@cloudflare/vitest-plugin";

// Bindings the test pool provides (see vitest.config.ts and test/wrangler.test.jsonc).
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
      AUTH_SECRET: string;
      ADMIN_PASSWORD: string;
      GOOGLE_CLIENT_ID: string;
      GOOGLE_CLIENT_SECRET: string;
      ALLOWED_EMAILS?: string;
      // Off by default in tests; a test passes them to the calls that need them.
      DEFAULT_PLAN?: string;
      CLOUDFLARE_EMAIL_TOKEN?: string;
      CLOUDFLARE_EMAIL_ACCOUNT_ID?: string;
      EMAIL_FROM?: string;
      APP_URL?: string;
      PUBLIC_SITE?: string;
      CONTACT_EMAIL?: string;
    }
  }
}
