import type { Env } from "./env";

/**
 * Outgoing email, through Cloudflare Email Sending: the same account the
 * Worker runs in, and no second provider to sign up with. Optional
 * everywhere: unless CLOUDFLARE_EMAIL_TOKEN, CLOUDFLARE_EMAIL_ACCOUNT_ID and
 * EMAIL_FROM are all set, nothing is sent and nothing depends on it (an
 * invitation is also a link the inviter can pass on themselves).
 *
 * https://developers.cloudflare.com/email-service/api/send-emails/rest-api/
 */
export interface Email {
  to: string;
  subject: string;
  /** Paragraphs of plain text. A paragraph that is only a URL becomes a link. */
  paragraphs: string[];
  /** Small print under the message. */
  footer?: string;
}

type EmailSettings = Pick<
  Env,
  "CLOUDFLARE_EMAIL_TOKEN" | "CLOUDFLARE_EMAIL_ACCOUNT_ID" | "EMAIL_FROM"
>;

export function emailConfigured(env: EmailSettings): boolean {
  return Boolean(env.CLOUDFLARE_EMAIL_TOKEN && env.CLOUDFLARE_EMAIL_ACCOUNT_ID && env.EMAIL_FROM);
}

/** Where this instance lives, for links in emails. A request's own origin is the fallback. */
export function appUrl(env: Pick<Env, "APP_URL">, requestOrigin?: string): string | undefined {
  const configured = env.APP_URL?.trim().replace(/\/+$/, "");
  return configured || requestOrigin;
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const isUrl = (text: string) => /^https?:\/\/\S+$/.test(text);

export function renderEmail(email: Email): { text: string; html: string } {
  const text = [...email.paragraphs, ...(email.footer ? [email.footer] : [])].join("\n\n");
  const body = email.paragraphs
    .map((paragraph) =>
      isUrl(paragraph)
        ? `<p style="margin:0 0 16px"><a href="${escapeHtml(paragraph)}" style="color:#3a41e0">${escapeHtml(paragraph)}</a></p>`
        : `<p style="margin:0 0 16px;white-space:pre-wrap">${escapeHtml(paragraph)}</p>`,
    )
    .join("");
  const footer = email.footer
    ? `<p style="margin:24px 0 0;color:#737373;font-size:13px">${escapeHtml(email.footer)}</p>`
    : "";
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.5;color:#171717;max-width:560px">${body}${footer}</div>`;
  return { text, html };
}

/** What Cloudflare answers. `success` means the request was taken, not that the address was. */
interface SendAnswer {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: {
    queued?: string[];
    delivered?: string[];
    permanent_bounces?: string[];
    suppressed_recipients?: string[];
  } | null;
}

/** Send one email. Never throws: a message that cannot be sent is logged and reported as false. */
export async function sendEmail(env: Env, email: Email): Promise<boolean> {
  if (!emailConfigured(env)) return false;
  const account = encodeURIComponent(env.CLOUDFLARE_EMAIL_ACCOUNT_ID as string);
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/email/sending/send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.CLOUDFLARE_EMAIL_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          from: env.EMAIL_FROM,
          to: email.to,
          // Names that people chose end up in subjects. A subject is one line.
          subject: email.subject.replace(/[\r\n]+/g, " "),
          ...renderEmail(email),
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const answer = (await response.json().catch(() => undefined)) as SendAnswer | undefined;
    if (!response.ok || !answer?.success) {
      // Logged without the address: who was written to is not for the logs.
      console.error("email was not accepted", response.status, JSON.stringify(answer?.errors));
      return false;
    }
    // An address that bounced for good before, or asked not to be written to,
    // is reported back in an answer that otherwise says "success".
    const refused =
      (answer.result?.permanent_bounces?.length ?? 0) +
      (answer.result?.suppressed_recipients?.length ?? 0);
    if (refused > 0) console.warn("email was not sent: the address bounces or is suppressed");
    return refused === 0;
  } catch (error) {
    console.error("email could not be sent", error);
    return false;
  }
}
