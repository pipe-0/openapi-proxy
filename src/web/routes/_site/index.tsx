import { createFileRoute } from "@tanstack/react-router";
import { Landing } from "@/site/landing";
import { originOf, SITE_DESCRIPTION, SITE_TITLE, siteHead } from "@/site/site";

export const Route = createFileRoute("/_site/")({
  head: ({ matches }) => {
    const origin = originOf(matches);
    return origin
      ? siteHead({ title: SITE_TITLE, description: SITE_DESCRIPTION, url: `${origin}/` })
      : { meta: [{ title: SITE_TITLE }, { name: "description", content: SITE_DESCRIPTION }] };
  },
  component: Landing,
});
