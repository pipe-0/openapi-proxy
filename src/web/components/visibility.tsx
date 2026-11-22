import { ChevronDownIcon, GlobeIcon, LockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Visibility } from "@/lib/api";

export const VISIBILITY: Record<Visibility, { label: string; means: string }> = {
  public: { label: "Public", means: "Anyone with the URL can read it." },
  private: { label: "Private", means: "Readers send an API key of this workspace." },
};

/** Who may read a variant at its URL, and the control that changes it. */
export function VisibilityMenu({
  value,
  onChange,
  disabled,
}: {
  value: Visibility;
  onChange: (next: Visibility) => void;
  disabled?: boolean;
}) {
  const Icon = value === "private" ? LockIcon : GlobeIcon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" aria-label="Who can read it" disabled={disabled} />}
      >
        <Icon />
        {VISIBILITY[value].label}
        <ChevronDownIcon className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(next as Visibility)}
        >
          {(["public", "private"] as const).map((option) => (
            <DropdownMenuRadioItem key={option} value={option} closeOnClick>
              <span className="flex flex-col">
                <span>{VISIBILITY[option].label}</span>
                <span className="text-[12.5px] leading-[18px] text-muted-foreground">
                  {VISIBILITY[option].means}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
