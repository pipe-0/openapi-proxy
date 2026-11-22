import { Link } from "@tanstack/react-router";
import { Mark, Wordmark } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { GITHUB_URL } from "./site";

const quietLink =
  "rounded-md text-[14px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50";

/** Top of every page of the site: the name, and the way in. */
export function SiteHeader({ blog }: { blog: boolean }) {
  return (
    <header className="mx-auto flex h-16 w-full max-w-6xl items-center gap-6 px-6">
      <Link
        to="/"
        className="flex items-center gap-2 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <Mark />
        <Wordmark />
      </Link>
      <span className="flex-1" />
      {/* On a phone the header is the name and the way in; the rest is in the footer. */}
      <Link to="/docs" className={cn(quietLink, "hidden sm:block")}>
        Docs
      </Link>
      <Link to="/pricing" className={cn(quietLink, "hidden sm:block")}>
        Pricing
      </Link>
      {blog && (
        <Link to="/blog" className={cn(quietLink, "hidden sm:block")}>
          Blog
        </Link>
      )}
      <a href={GITHUB_URL} className={cn(quietLink, "hidden sm:block")}>
        GitHub
      </a>
      <Button variant="outline" nativeButton={false} render={<a href="/login" />}>
        Sign in
      </Button>
    </header>
  );
}

export function SiteFooter({ blog }: { blog: boolean }) {
  return (
    <footer className="mx-auto mt-32 w-full max-w-6xl px-6 pb-12">
      <div className="flex flex-col gap-6 border-t pt-8 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2">
          <Mark className="size-5" />
          <Wordmark className="text-[14px]" />
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2 sm:ml-auto">
          <Link to="/docs" className={quietLink}>
            Docs
          </Link>
          <Link to="/pricing" className={quietLink}>
            Pricing
          </Link>
          {blog && (
            <Link to="/blog" className={quietLink}>
              Blog
            </Link>
          )}
          <a href={GITHUB_URL} className={quietLink}>
            GitHub
          </a>
          <Link to="/about" className={quietLink}>
            About
          </Link>
          <Link to="/terms" className={quietLink}>
            Terms
          </Link>
          <Link to="/privacy" className={quietLink}>
            Privacy
          </Link>
        </nav>
      </div>
      <p className="mt-6 max-w-xl text-[13px] leading-5 text-muted-foreground">
        Made by the team behind{" "}
        <a href="https://pipe0.com" className="underline decoration-border underline-offset-4">
          pipe0
        </a>
        . Open source: the app is licensed under FSL-1.1-MIT, free to use, change and host for
        yourself, and the filter engine is MIT.
      </p>
    </footer>
  );
}
