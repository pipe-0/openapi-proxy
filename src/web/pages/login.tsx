import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { Mark } from "@/components/brand";
import { CopyButton } from "@/components/copy-button";
import { Notice, useTitle } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, errorMessage, queries } from "@/lib/api";
import { APP_HOME } from "@/lib/return-path";
import { cn } from "@/lib/utils";

const SECRETS = [
  "wrangler secret put AUTH_SECRET",
  "wrangler secret put GOOGLE_CLIENT_ID",
  "wrangler secret put GOOGLE_CLIENT_SECRET",
].join("\n");

/** What better-auth puts in `?error=` after a failed sign-in, in plain words. */
function describeError(code: string | undefined): string | undefined {
  if (!code) return undefined;
  if (code === "not_allowed") return "That Google account is not allowed to sign in here.";
  if (code === "access_denied") return "Sign-in was cancelled.";
  return "Signing in did not work. Try again.";
}

export function LoginPage() {
  useTitle("Sign in");
  const { from, error: errorCode } = useSearch({ from: "/_client/login" });
  const config = useQuery(queries.authConfig);
  const [password, setPassword] = useState("");
  const [error, setError] = useState(describeError(errorCode));
  const [shaking, setShaking] = useState(false);
  const [pending, setPending] = useState<"google" | "password">();

  const fail = (reason: unknown) => {
    setError(errorMessage(reason));
    setShaking(true);
    setTimeout(() => setShaking(false), 400);
    setPending(undefined);
  };

  const withGoogle = async () => {
    setPending("google");
    setError(undefined);
    try {
      const { url } = await api.signInWithGoogle(from ?? APP_HOME);
      window.location.assign(url);
    } catch (reason) {
      fail(reason);
    }
  };

  const withPassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending || password === "") return;
    setPending("password");
    setError(undefined);
    try {
      await api.signInWithPassword(password);
      // A full navigation, so every cached answer from a previous session is gone.
      window.location.assign(from ?? APP_HOME);
    } catch (reason) {
      fail(reason);
    }
  };

  const methods = config.data?.methods;

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/60 p-6">
      <div className={cn("w-full max-w-[360px]", shaking && "animate-shake")}>
        <div className="rounded-2xl bg-card p-7 shadow-float">
          <Mark className="size-9" />
          <h1 className="type-title mt-5 text-[22px] leading-7">Sign in to openapi-proxy</h1>
          <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
            Serve filtered versions of your OpenAPI document at stable URLs.
          </p>

          {config.data?.configured === false ? (
            <div className="mt-6">
              <p className="text-[13px] leading-5">
                {config.data.problem === "example-values"
                  ? "This deployment still uses the example secrets, which only work on localhost. Set your own, then reload."
                  : "This deployment cannot sign anyone in yet. Set these secrets, then reload."}
              </p>
              <div className="mt-3 flex items-start gap-1 rounded-lg bg-muted p-2.5">
                <pre className="scroll-quiet min-w-0 flex-1 overflow-x-auto font-mono text-[11.5px] leading-5">
                  {SECRETS}
                </pre>
                <CopyButton value={SECRETS} what="Commands copied" size="icon-sm" variant="ghost" />
              </div>
              <p className="mt-3 text-[12.5px] leading-5 text-muted-foreground">
                Running locally? Copy{" "}
                <code className="font-sans font-medium text-foreground">.env.example</code> to{" "}
                <code className="font-sans font-medium text-foreground">.env</code>.
              </p>
            </div>
          ) : (
            <div className="mt-6 flex flex-col gap-3">
              {error && <Notice tone="bad">{error}</Notice>}

              {methods?.google && (
                <Button
                  variant="outline"
                  size="lg"
                  className="h-10 w-full"
                  onClick={withGoogle}
                  loading={pending === "google"}
                  disabled={pending !== undefined}
                >
                  {pending !== "google" && <GoogleLogo />}
                  Continue with Google
                </Button>
              )}

              {methods?.google && methods.password && (
                <div className="flex items-center gap-3 text-[11.5px] text-faint">
                  <span className="h-px flex-1 bg-border" />
                  or
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}

              {methods?.password && (
                <form onSubmit={withPassword} className="flex flex-col gap-2">
                  <Input
                    type="password"
                    autoFocus={!methods.google}
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setError(undefined);
                    }}
                    placeholder="Admin password"
                    aria-label="Password"
                    className="h-10"
                  />
                  <Button
                    type="submit"
                    size="lg"
                    variant={methods.google ? "outline" : "default"}
                    className="h-10 w-full"
                    loading={pending === "password"}
                    disabled={pending !== undefined || password === ""}
                  >
                    Sign in with password
                  </Button>
                  <p className="text-center text-[12px] leading-[18px] text-faint">
                    The built-in admin of this instance, for running it without Google sign-in.
                  </p>
                </form>
              )}

              {config.data?.legal && (
                <p className="mt-1 text-center text-[12px] leading-5 text-muted-foreground">
                  By signing in you agree to the{" "}
                  <a href="/terms" className="underline decoration-border underline-offset-2">
                    terms
                  </a>{" "}
                  and the{" "}
                  <a href="/privacy" className="underline decoration-border underline-offset-2">
                    privacy policy
                  </a>
                  .
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function GoogleLogo() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true" className="size-4">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.96 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l3-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}
