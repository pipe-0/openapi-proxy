import type { Visibility } from "@openapi-proxy/core";
import { ChevronDownIcon, GlobeIcon, LockIcon, WaypointsIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

export const VISIBILITY: Record<Visibility, { label: string; means: string }> = {
  public: { label: "Public", means: "Anyone with the URL can read it." },
  private: { label: "Private", means: "Readers send an API key of this workspace." },
};

/**
 * What holds for a variant that does not say who may read it: what its
 * project says, or else the workspace. `value` is null where the workspace
 * is not known, as for a definition file that is not deployed yet.
 */
export interface InheritedVisibility {
  value: Visibility | null;
  from: "project" | "workspace";
}

const INHERIT = "inherit";

/** Who may read a variant at its URL, and the control that changes it. */
export function VisibilityMenu({
  stated,
  inherited,
  onChange,
  disabled,
}: {
  /** What the variant says itself. Undefined: nothing. */
  stated: Visibility | undefined;
  inherited: InheritedVisibility;
  /** Called with undefined to have the variant say nothing again. */
  onChange: (next: Visibility | undefined) => void;
  disabled?: boolean;
}) {
  const effective = stated ?? inherited.value;
  const Icon =
    effective === "private" ? LockIcon : effective === "public" ? GlobeIcon : WaypointsIcon;
  const whose = inherited.from === "project" ? "the project" : "the workspace";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" aria-label="Who can read it" disabled={disabled} />}
      >
        <Icon />
        {effective ? VISIBILITY[effective].label : "Workspace default"}
        {stated === undefined && effective && (
          <span className="font-normal text-muted-foreground">by default</span>
        )}
        <ChevronDownIcon className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuRadioGroup
          value={stated ?? INHERIT}
          onValueChange={(next) => onChange(next === INHERIT ? undefined : (next as Visibility))}
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
          <DropdownMenuSeparator />
          <DropdownMenuRadioItem value={INHERIT} closeOnClick>
            <span className="flex flex-col">
              <span>Default</span>
              <span className="text-[12.5px] leading-[18px] text-muted-foreground">
                {inherited.value
                  ? `As ${whose} says, which is ${inherited.value} at the moment.`
                  : "As the workspace it is deployed to says."}
              </span>
            </span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
