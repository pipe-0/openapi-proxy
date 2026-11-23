import { createFileRoute } from "@tanstack/react-router";
import { VariantNewPage } from "@/pages/variant-editor";

// The editor carries the filter engine and the YAML library. Route components
// are split into their own chunks, so it only loads when one of these opens.
export const Route = createFileRoute("/_client/_app/p/$project/new")({
  // `from` names a variant to start as a copy of.
  validateSearch: (search: Record<string, unknown>): { from?: string } =>
    typeof search.from === "string" ? { from: search.from } : {},
  component: VariantNewPage,
});
