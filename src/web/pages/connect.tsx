import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ConnectForm } from "@/components/connect-form";
import { useTitle } from "@/components/page";
import { queries } from "@/lib/api";

/**
 * A project starts from a document. Connecting one is the first thing anyone
 * does here, so the screen is that one field and nothing else. Success leads
 * straight into creating the project's first variant.
 */
export function ConnectPage() {
  useTitle("New project");
  const navigate = useNavigate();
  const { url } = useSearch({ from: "/_client/_app/connect" });
  const projects = useQuery(queries.projects);
  const me = useQuery(queries.me);
  const first = projects.data?.length === 0;

  return (
    <div className="scroll-quiet flex h-full flex-col items-center overflow-y-auto px-6">
      <div className="w-full max-w-xl pt-[18vh] pb-20">
        <h1 className="type-title text-balance text-[32px] leading-[38px]">
          {first ? "One OpenAPI document in, the right one out for each audience." : "New project"}
        </h1>
        <p className="mt-3 max-w-lg text-[15px] leading-6 text-pretty text-muted-foreground">
          {first
            ? "Point at the document your backend generates. Choose what each consumer should see. Hand out a URL that stays current by itself."
            : "A project is one API: point at its OpenAPI document. More documents can be merged into it later."}
        </p>
        <div className="mt-8">
          <ConnectForm
            initialUrl={url ?? ""}
            urlPrefix={me.data?.urlPrefix ?? `${window.location.origin}/v/`}
            onConnected={(project) => navigate({ to: "/p/$project/new", params: { project } })}
          />
        </div>
        <p className="mt-6 text-[12.5px] text-faint">
          JSON or YAML. OpenAPI 3.0, 3.1 and 3.2. Up to 5 MB.
        </p>
      </div>
    </div>
  );
}
