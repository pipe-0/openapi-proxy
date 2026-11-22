import { createFileRoute } from "@tanstack/react-router";
import { VariantEditorPage } from "@/pages/variant-editor";

export const Route = createFileRoute("/_client/_app/p/$projectId/v/$variantId")({
  validateSearch: (search: Record<string, unknown>): { created?: boolean } =>
    search.created === true ? { created: true } : {},
  component: VariantEditorPage,
});
