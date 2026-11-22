import type { Auth } from "./auth";

export interface Env {
  DB: D1Database;
  /**
   * Optional. Cloudflare's rate limiter, holding each workspace's budget of
   * API requests per minute (see rate-limit.ts and wrangler.jsonc).
   */
  API_RATE_LIMIT?: RateLimit;
  /** Signs sessions and encrypts stored source credentials. Required. */
  AUTH_SECRET?: string;
  /** Google OAuth client. With both set, people sign in with Google. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /**
   * Optional. Enables signing in as one built-in admin with this password:
   * for local development, tests, and self-hosting without a Google client.
   */
  ADMIN_PASSWORD?: string;
  /**
   * Optional. Comma-separated emails and domains (`ada@example.com, example.org`)
   * allowed to sign in with Google. Empty means anyone can. Someone with a
   * pending invitation to a workspace is always allowed.
   */
  ALLOWED_EMAILS?: string;
  /**
   * Optional. With all three set, invitations and change notifications are
   * emailed through Cloudflare Email Sending: an API token that may send
   * email, the account that owns the sending domain, and the sender.
   */
  CLOUDFLARE_EMAIL_TOKEN?: string;
  CLOUDFLARE_EMAIL_ACCOUNT_ID?: string;
  /** The sender, e.g. `openapi-proxy <notify@mail.example.com>`. Its domain has to be set up for sending. */
  EMAIL_FROM?: string;
  /**
   * Optional. Where this instance lives, e.g. `https://proxy.example.com`.
   * Emails sent by the hourly check have no request to take the address from,
   * so without it they carry no links.
   */
  APP_URL?: string;
  /** Optional. "true" serves the landing page and the blog. Off, `/` goes straight to the app. */
  PUBLIC_SITE?: string;
  /**
   * Optional. The address requests for Pro are sent to. Setting it is what
   * makes an instance sell plans: workspaces are then on Free until they
   * have a subscription (src/server/plans.ts). Without it there are no
   * plans, and every workspace has everything, which is what self-hosting
   * wants.
   */
  CONTACT_EMAIL?: string;
}

export type AppContext = {
  Bindings: Env;
  Variables: {
    /** The better-auth instance for this request. */
    auth: Auth;
    /** The organization the signed-in user is acting for. */
    organizationId: string;
    /** "owner" for whoever created the workspace, "member" for everyone invited into it. */
    role: "owner" | "member";
    /** Which door the request came through: a signed-in browser, or an API key. */
    via: "session" | "key";
    user: { id: string; name: string; email: string; image?: string | null | undefined };
  };
};
