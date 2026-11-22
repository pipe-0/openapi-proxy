import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRightIcon, KeyRoundIcon, MergeIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  type HeaderDraft,
  HeaderEditor,
  headersComplete,
  newHeader,
  toHeaderInput,
} from "@/components/header-editor";
import { Notice } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, type NewSource, type Project, queries, RequestError } from "@/lib/api";
import { cn, looksLikeUrl } from "@/lib/utils";

/** One more document to merge in, while it is being typed. */
interface Extra {
  id: number;
  url: string;
  headers: HeaderDraft[];
}
let nextExtra = 1;
const blank = (): Extra => ({ id: nextExtra++, url: "", headers: [] });

/**
 * Point at an OpenAPI document. One field. Two things appear only when they
 * are needed: credentials, if the source turns us away, and more fields, if
 * several documents are to be merged into one project.
 */
export function ConnectForm({
  onConnected,
  initialUrl = "",
}: {
  onConnected: (project: Project) => void;
  /** Fetched straight away when given. */
  initialUrl?: string;
}) {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState(initialUrl);
  const [headers, setHeaders] = useState<HeaderDraft[]>([]);
  /** The documents after the first, once "merge several" was chosen. */
  const [extras, setExtras] = useState<Extra[]>([]);
  const merging = extras.length > 0;
  const more = extras.filter((extra) => extra.url.trim() !== "");

  const connect = useMutation({
    mutationFn: () => {
      const document = (address: string, drafts: HeaderDraft[]): NewSource => ({
        url: address.trim(),
        ...(drafts.length > 0 ? { headers: toHeaderInput(drafts) } : {}),
      });
      return api.createProject([
        document(url, headers),
        ...more.map((extra) => document(extra.url, extra.headers)),
      ]);
    },
    onSuccess: (project) => {
      queryClient.setQueryData<Project[]>(queries.projects.queryKey, (current) =>
        current?.some((existing) => existing.id === project.id)
          ? current
          : [...(current ?? []), project],
      );
      onConnected(project);
    },
    onError: (error) => {
      // Turned away: the source most likely wants credentials. With one
      // document it is clear which; offer the field.
      if (!merging && error instanceof RequestError && error.detail?.includes("request header")) {
        setHeaders((current) => (current.length > 0 ? current : [newHeader("Authorization")]));
      }
    },
  });

  const started = useRef(false);
  useEffect(() => {
    if (started.current || !looksLikeUrl(initialUrl)) return;
    started.current = true;
    connect.mutate();
  }, [initialUrl, connect]);

  const ready =
    looksLikeUrl(url) &&
    headersComplete(headers) &&
    more.every((extra) => looksLikeUrl(extra.url) && headersComplete(extra.headers));
  const error = connect.error instanceof RequestError ? connect.error : undefined;
  const change = (id: number, next: Partial<Extra>) =>
    setExtras((current) =>
      current.map((extra) => (extra.id === id ? { ...extra, ...next } : extra)),
    );

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !connect.isPending) connect.mutate();
      }}
    >
      <div
        className={cn(
          "material-raised flex h-12 items-center gap-2 rounded-xl pr-1.5 pl-4 transition-shadow focus-within:ring-3 focus-within:ring-ring/40",
        )}
      >
        <input
          // biome-ignore lint/a11y/noAutofocus: this field is the only thing to do on the screen
          autoFocus
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
            connect.reset();
          }}
          placeholder="https://api.example.com/openapi.json"
          aria-label={merging ? "Main OpenAPI document URL" : "OpenAPI document URL"}
          className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
          spellCheck={false}
          autoComplete="off"
          disabled={connect.isPending}
        />
        <Button type="submit" size="lg" disabled={!ready} loading={connect.isPending}>
          {connect.isPending ? "Fetching" : merging ? "Merge and connect" : "Connect"}
          {!connect.isPending && <ArrowRightIcon />}
        </Button>
      </div>

      {error && (
        <Notice tone="bad">
          <span className="font-medium">{error.message}</span>
          {error.detail && <span className="opacity-90"> {error.detail}</span>}
        </Notice>
      )}

      {headers.length > 0 && (
        <div className="mt-1">
          <p className="mb-2 text-[13px] text-muted-foreground">
            Request headers sent with every fetch of this document. Stored encrypted.
          </p>
          <HeaderEditor value={headers} onChange={setHeaders} autoFocus={Boolean(error)} />
        </div>
      )}

      {merging && (
        <div className="mt-2 flex flex-col gap-3">
          <p className="max-w-prose text-[13px] leading-5 text-muted-foreground">
            The document above is the main one: its title and servers describe the project. These
            are merged into it. Where two define the same operation, the earlier one is kept.
          </p>
          {extras.map((extra, index) => (
            <div key={extra.id} className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5">
                <Input
                  autoFocus={index === extras.length - 1}
                  value={extra.url}
                  onChange={(event) => {
                    change(extra.id, { url: event.target.value });
                    connect.reset();
                  }}
                  placeholder="https://billing.example.com/openapi.json"
                  aria-label={`Document ${index + 2} URL`}
                  className="h-9 text-[13px] md:text-[13px]"
                  spellCheck={false}
                  autoComplete="off"
                  disabled={connect.isPending}
                />
                {extra.headers.length === 0 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Document ${index + 2} needs credentials`}
                    title="It needs credentials"
                    onClick={() => change(extra.id, { headers: [newHeader("Authorization")] })}
                  >
                    <KeyRoundIcon />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove document ${index + 2}`}
                  onClick={() => setExtras((current) => current.filter((e) => e.id !== extra.id))}
                >
                  <XIcon />
                </Button>
              </div>
              {extra.headers.length > 0 && (
                <HeaderEditor
                  value={extra.headers}
                  onChange={(next) => change(extra.id, { headers: next })}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {!connect.isPending && (
        <div className="flex flex-wrap gap-1">
          {headers.length === 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setHeaders([newHeader("Authorization")])}
            >
              <KeyRoundIcon /> The document needs credentials
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExtras((current) => [...current, blank()])}
          >
            {merging ? <PlusIcon /> : <MergeIcon />}
            {merging ? "Add another document" : "Merge several documents into one"}
          </Button>
        </div>
      )}
    </form>
  );
}
