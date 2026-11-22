import { type ParsedLocation, redirect } from "@tanstack/react-router";
import { queries } from "@/lib/api";
import { queryClient } from "@/lib/query-client";
import { APP_HOME } from "@/lib/return-path";

/**
 * A route's `beforeLoad` for pages that need someone signed in. Without a
 * session it leads to the sign-in page, which brings them back afterwards.
 */
export async function requireSession({ location }: { location: ParsedLocation }): Promise<void> {
  try {
    await queryClient.ensureQueryData(queries.me);
  } catch {
    throw redirect({
      to: "/login",
      search: location.href === APP_HOME ? {} : { from: location.href },
    });
  }
}
