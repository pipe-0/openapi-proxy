import { createFileRoute } from "@tanstack/react-router";
import { Pricing } from "@/site/pricing";
import { originOf, siteHead } from "@/site/site";

const TITLE = "Pricing · openapi-proxy";
const DESCRIPTION =
  "openapi-proxy is free for a few APIs and $69 per year for 100. Every feature is in both plans, and the open source version has no plan at all.";

export const Route = createFileRoute("/_site/pricing")({
  head: ({ matches }) => {
    const origin = originOf(matches);
    return origin
      ? siteHead({ title: TITLE, description: DESCRIPTION, url: `${origin}/pricing` })
      : { meta: [{ title: TITLE }, { name: "description", content: DESCRIPTION }] };
  },
  component: Pricing,
});
