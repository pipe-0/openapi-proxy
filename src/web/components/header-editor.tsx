import { PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { HeaderInput } from "@/lib/api";

export interface HeaderDraft {
  id: number;
  name: string;
  value: string;
  /** Already saved on the server. Its value is not known to the browser. */
  stored: boolean;
}

let nextId = 1;
export const newHeader = (name = "", stored = false): HeaderDraft => ({
  id: nextId++,
  name,
  value: "",
  stored,
});

/** What to send: stored headers keep their value unless a new one was typed. */
export function toHeaderInput(drafts: HeaderDraft[]): HeaderInput[] {
  return drafts
    .filter((draft) => draft.name.trim() !== "")
    .map((draft) => ({
      name: draft.name.trim(),
      ...(draft.stored && draft.value === "" ? {} : { value: draft.value }),
    }));
}

export function headersComplete(drafts: HeaderDraft[]): boolean {
  return drafts.every(
    (draft) =>
      (draft.name.trim() === "" && draft.value === "") ||
      (draft.name.trim() !== "" && (draft.stored || draft.value !== "")),
  );
}

/**
 * Request headers sent when fetching the source, typically one
 * `Authorization` line. Values are write-only: once saved they show as stored
 * and can be replaced, never read back.
 */
export function HeaderEditor({
  value,
  onChange,
  autoFocus = false,
}: {
  value: HeaderDraft[];
  onChange: (value: HeaderDraft[]) => void;
  autoFocus?: boolean;
}) {
  const patch = (id: number, changes: Partial<HeaderDraft>) =>
    onChange(value.map((draft) => (draft.id === id ? { ...draft, ...changes } : draft)));

  return (
    <div className="flex flex-col gap-2">
      {value.map((draft, index) => (
        <div key={draft.id} className="flex gap-2">
          <Input
            value={draft.name}
            onChange={(event) => patch(draft.id, { name: event.target.value, stored: false })}
            placeholder="Authorization"
            aria-label="Header name"
            className="w-44 shrink-0 text-[13px] md:text-[13px]"
            spellCheck={false}
            autoComplete="off"
          />
          <Input
            type="password"
            value={draft.value}
            onChange={(event) => patch(draft.id, { value: event.target.value })}
            placeholder={draft.stored ? "Stored. Type to replace" : "Bearer …"}
            aria-label={`Value for ${draft.name || "header"}`}
            className="text-[13px] md:text-[13px]"
            spellCheck={false}
            autoComplete="off"
            autoFocus={autoFocus && index === 0}
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onChange(value.filter((other) => other.id !== draft.id))}
            aria-label={`Remove ${draft.name || "header"}`}
          >
            <XIcon />
          </Button>
        </div>
      ))}
      <div>
        <Button variant="outline" size="sm" onClick={() => onChange([...value, newHeader()])}>
          <PlusIcon /> Add header
        </Button>
      </div>
    </div>
  );
}
