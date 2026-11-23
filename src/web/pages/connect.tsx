import { useTitle } from "@editor/components/page";
import { Segmented } from "@editor/components/segmented";
import { WAYS } from "@openapi-proxy/core";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { ConnectForm } from "@/components/connect-form";
import { FromRepository } from "@/components/from-repository";
import { queries } from "@/lib/api";

type Way = keyof typeof WAYS;

/**
 * A project starts in one of two ways, and this screen is where that is
 * chosen: from a URL, here in the app, or from a definition file in a
 * repository. Both are said in the same words wherever they are offered.
 * Connecting a URL leads straight into the project's first variant.
 */
export function ConnectPage() {
  useTitle("New project");
  const navigate = useNavigate();
  const { url, from } = useSearch({ from: "/_client/_app/connect" });
  const projects = useQuery(queries.projects);
  const me = useQuery(queries.me);
  const first = projects.data?.length === 0;
  const [way, setWay] = useState<Way>(from === "repository" ? "repository" : "url");

  return (
    <div className="scroll-quiet flex h-full flex-col items-center overflow-y-auto px-6">
      <div className="w-full max-w-xl pt-[14vh] pb-20">
        <h1 className="type-title text-balance text-[32px] leading-[38px]">
          {first ? "One OpenAPI document in, the right one out for each audience." : "New project"}
        </h1>
        <p className="mt-3 max-w-lg text-[15px] leading-6 text-pretty text-muted-foreground">
          {first
            ? "Choose what each consumer of your API should see, and hand out a URL that serves exactly that."
            : "A project is one API, and the variants of it that are served."}
        </p>

        <div className="mt-8 flex flex-col gap-3">
          <div>
            <Segmented
              aria-label="How the project is made"
              value={way}
              onValueChange={setWay}
              options={[
                { value: "url", label: WAYS.url.title },
                { value: "repository", label: WAYS.repository.title },
              ]}
            />
          </div>
          <p className="max-w-lg text-[13px] leading-5 text-muted-foreground">{WAYS[way].when}</p>
        </div>

        {/* Both stay on the page: a key that was shown once is still there after a look at the other way. */}
        <div className="mt-6" hidden={way !== "url"}>
          <ConnectForm
            initialUrl={url ?? ""}
            urlPrefix={me.data?.urlPrefix ?? `${window.location.origin}/v/`}
            onConnected={(project) => navigate({ to: "/p/$project/new", params: { project } })}
          />
          <p className="mt-6 text-[12.5px] text-faint">
            JSON or YAML. OpenAPI 3.0, 3.1 and 3.2. Up to 5 MB.
          </p>
        </div>
        <div className="mt-6" hidden={way !== "repository"}>
          <FromRepository />
        </div>
      </div>
    </div>
  );
}
