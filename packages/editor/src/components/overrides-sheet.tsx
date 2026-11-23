import {
  type DocumentOverrides,
  isJsonObject,
  type OpenAPIDocument,
  readOverrides,
  type ServerOverride,
} from "@openapi-proxy/core";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { DocsLink } from "./docs-link";
import { Field } from "./page";

/** What the document itself says at the top, to show what an empty field stands for. */
function ownTop(doc: OpenAPIDocument | undefined) {
  const info = isJsonObject(doc?.info) ? doc.info : {};
  const servers = (Array.isArray(doc?.servers) ? doc.servers : []).flatMap((server) =>
    isJsonObject(server) && typeof server.url === "string"
      ? [
          {
            url: server.url,
            ...(typeof server.description === "string" ? { description: server.description } : {}),
          },
        ]
      : [],
  );
  return {
    title: typeof info.title === "string" ? info.title : "",
    description: typeof info.description === "string" ? info.description : "",
    servers,
  };
}

/** How many of the three a variant states itself, for the button that opens this. */
export function overrideCount(overrides: DocumentOverrides | null): number {
  return overrides ? Object.keys(overrides).length : 0;
}

/**
 * The title, description and servers stated instead of the document's: by a
 * variant for itself, or by a project for all of its variants. This is where
 * a variant becomes "staging" or "public": the operations stay, and what
 * readers are told about where the API lives changes. Nothing is saved
 * here; it becomes part of what is saved next.
 *
 * A field that is left empty stands for what is said further up: by the
 * project (for a variant), and then by the document. The field shows it.
 */
export function OverridesSheet({
  doc,
  mainSource,
  value,
  inherited,
  scope = "variant",
  readOnly = false,
  onChange,
  onClose,
}: {
  /** The project's document, once it has loaded. */
  doc: OpenAPIDocument | undefined;
  mainSource: string;
  value: DocumentOverrides | null;
  /** For a variant: what its project states for every variant. */
  inherited?: DocumentOverrides | undefined;
  /** Whose these are: one variant's, or the project's for all of them. */
  scope?: "variant" | "project";
  /** Show them without letting them be changed. */
  readOnly?: boolean;
  /**
   * Take what was entered. Where that saves it at once, return the save: the
   * sheet waits for it, and stays open with what was typed if it fails.
   */
  onChange: (next: DocumentOverrides | null) => unknown;
  onClose: () => void;
}) {
  const document = ownTop(doc);
  // What an empty field stands for, key by key: the project's, or else the document's.
  const own = {
    title: inherited?.title ?? document.title,
    description: inherited?.description ?? document.description,
    servers: inherited?.servers ?? document.servers,
  };
  const fromProject = inherited !== undefined && Object.keys(inherited).length > 0;
  const serversFrom = inherited?.servers ? "the project says" : "in the document";
  const [title, setTitle] = useState(value?.title ?? "");
  const [description, setDescription] = useState(value?.description ?? "");
  const [servers, setServers] = useState<ServerOverride[]>(value?.servers ?? []);
  const [saving, setSaving] = useState(false);

  const read = readOverrides({
    title,
    description,
    // A row nobody typed in is not a server yet.
    servers: servers.filter((server) => server.url.trim() !== ""),
  });
  const problem = read && "problem" in read ? read.problem : undefined;
  const setServer = (index: number, change: Partial<ServerOverride>) =>
    setServers((current) =>
      current.map((server, at) => (at === index ? { ...server, ...change } : server)),
    );

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 data-[side=right]:sm:max-w-lg">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>Title and servers</SheetTitle>
          <SheetDescription className="text-[13px]">
            {scope === "project"
              ? "What readers of every variant see at the top, unless a variant says something else."
              : "What readers of this variant see at the top."}{" "}
            {scope === "project" &&
              !readOnly &&
              "Saved at once, for every variant that does not set its own. "}
            An empty field uses what{" "}
            {fromProject
              ? `the project says, and then what ${mainSource} says`
              : `${mainSource} says`}
            . <DocsLink slug="several-documents#environments">Environments</DocsLink>
          </SheetDescription>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (readOnly || saving || problem || (read && "problem" in read)) return;
            const save = onChange(read);
            if (!(save instanceof Promise)) return onClose();
            setSaving(true);
            save.then(onClose, () => setSaving(false));
          }}
        >
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
            <Field label="Title" htmlFor="override-title">
              <Input
                id="override-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder={own.title}
                maxLength={200}
                readOnly={readOnly}
              />
            </Field>
            <Field label="Description" htmlFor="override-description">
              <textarea
                id="override-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder={own.description.slice(0, 300)}
                rows={4}
                maxLength={5000}
                readOnly={readOnly}
                className="w-full rounded-lg border border-input bg-background px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              />
            </Field>
            <Field
              label="Servers"
              error={problem}
              hint={
                servers.length > 0
                  ? "Where the API is reached. Tools use the first unless someone picks another."
                  : undefined
              }
            >
              <div className="flex flex-col gap-2">
                {servers.length === 0 && (
                  <p className="text-[13px] leading-5 text-muted-foreground">
                    {own.servers.length > 0
                      ? `As ${serversFrom}: ${own.servers.map((server) => server.url).join(", ")}`
                      : "The document lists none."}
                  </p>
                )}
                {servers.map((server, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity but their place
                  <div key={index} className="flex items-center gap-2">
                    <Input
                      aria-label={`Server ${index + 1} URL`}
                      value={server.url}
                      onChange={(event) => setServer(index, { url: event.target.value })}
                      placeholder="https://staging.example.com"
                      className="min-w-0 flex-[2] text-[13px] md:text-[13px]"
                      spellCheck={false}
                      autoComplete="off"
                      readOnly={readOnly}
                    />
                    <Input
                      aria-label={`Server ${index + 1} description`}
                      value={server.description ?? ""}
                      onChange={(event) => setServer(index, { description: event.target.value })}
                      placeholder={index === 0 ? "Staging" : "Production"}
                      className="min-w-0 flex-1"
                      maxLength={200}
                      readOnly={readOnly}
                    />
                    {!readOnly && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove server ${index + 1}`}
                        onClick={() =>
                          setServers((current) => current.filter((_, at) => at !== index))
                        }
                      >
                        <XIcon />
                      </Button>
                    )}
                  </div>
                ))}
                <div className={readOnly ? "hidden" : "flex flex-wrap gap-2"}>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setServers((current) =>
                        // The first click starts from what the document lists.
                        current.length === 0 && own.servers.length > 0
                          ? own.servers
                          : [...current, { url: "" }],
                      )
                    }
                  >
                    <PlusIcon />
                    {servers.length === 0 && own.servers.length > 0
                      ? "Change the servers"
                      : "Add server"}
                  </Button>
                  {servers.length > 0 && (
                    <Button variant="ghost" size="sm" onClick={() => setServers([])}>
                      {inherited?.servers ? "Use the project's" : "Use the document's"}
                    </Button>
                  )}
                </div>
              </div>
            </Field>
          </div>
          <SheetFooter className="flex-row items-center border-t">
            {readOnly ? (
              <Button onClick={onClose}>Close</Button>
            ) : (
              <>
                <Button type="submit" disabled={Boolean(problem)} loading={saving}>
                  {scope === "project" ? "Save" : "Done"}
                </Button>
                <Button variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
              </>
            )}
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
