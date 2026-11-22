import { createFileRoute } from "@tanstack/react-router";
import { safeReturnPath } from "@/lib/return-path";
import { LoginPage } from "@/pages/login";

export const Route = createFileRoute("/_client/login")({
  validateSearch: (search: Record<string, unknown>): { from?: string; error?: string } => {
    const from = safeReturnPath(search.from);
    return {
      ...(from ? { from } : {}),
      ...(typeof search.error === "string" ? { error: search.error } : {}),
    };
  },
  component: LoginPage,
});
