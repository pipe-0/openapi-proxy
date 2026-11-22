import { createRootRoute, HeadContent, Scripts } from "@tanstack/react-router";
import appCss from "../styles.css?url";

/**
 * Headers for every page this app renders. `public/_headers` only reaches
 * static files, so they are set here.
 *
 * Scripts: our own files, plus the inline ones Start writes for this response
 * (they carry the nonce). No 'unsafe-inline', no eval. Development is left
 * alone, because Vite's hot reloading injects scripts of its own.
 */
function securityHeaders(nonce: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
  if (nonce && !import.meta.env.DEV) {
    headers["Content-Security-Policy"] = [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https://*.googleusercontent.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");
  }
  return headers;
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "color-scheme", content: "light dark" },
      { title: "openapi-proxy" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
    ],
    // Applies the saved color scheme before the first paint. A file, so the
    // policy above needs no exception for it.
    scripts: [{ src: "/theme.js" }],
  }),
  headers: ({ ssr }) => securityHeaders(ssr?.nonce),
  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    // theme.js sets the `dark` class before React sees the element.
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
