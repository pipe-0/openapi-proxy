import { VARIANT_ICONS, type VariantIconName } from "@openapi-proxy/core";
import {
  BookOpenIcon,
  BotIcon,
  CodeIcon,
  FileTextIcon,
  FlaskConicalIcon,
  GlobeIcon,
  LayersIcon,
  LockIcon,
  type LucideIcon,
  PackageIcon,
  PlugIcon,
  RocketIcon,
  ShieldIcon,
  StarIcon,
  TerminalIcon,
  UsersIcon,
  ZapIcon,
} from "lucide-react";
import { cn } from "../lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/** Each icon, and what it is called when it is read out. */
const ICONS: Record<VariantIconName, { icon: LucideIcon; label: string }> = {
  file: { icon: FileTextIcon, label: "Document" },
  book: { icon: BookOpenIcon, label: "Docs" },
  code: { icon: CodeIcon, label: "SDK" },
  globe: { icon: GlobeIcon, label: "Public" },
  lock: { icon: LockIcon, label: "Internal" },
  users: { icon: UsersIcon, label: "Partners" },
  bot: { icon: BotIcon, label: "Agents" },
  terminal: { icon: TerminalIcon, label: "Command line" },
  package: { icon: PackageIcon, label: "Package" },
  rocket: { icon: RocketIcon, label: "Production" },
  flask: { icon: FlaskConicalIcon, label: "Staging" },
  shield: { icon: ShieldIcon, label: "Admin" },
  star: { icon: StarIcon, label: "Star" },
  zap: { icon: ZapIcon, label: "Fast" },
  layers: { icon: LayersIcon, label: "Layers" },
  plug: { icon: PlugIcon, label: "Integration" },
};

/** A variant's icon. One that was never chosen is a plain document. */
export function VariantIcon({
  name,
  className,
}: {
  name: VariantIconName | null | undefined;
  className?: string;
}) {
  const shown = name ?? "file";
  const Icon = ICONS[shown].icon;
  return <Icon data-icon={shown} className={cn("size-4 shrink-0", className)} aria-hidden="true" />;
}

/** The button that shows a variant's icon and lets its owner pick another. */
export function VariantIconPicker({
  value,
  onChange,
  disabled,
}: {
  value: VariantIconName | null;
  onChange: (next: VariantIconName) => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label="Variant icon"
        title="Change the icon shown in the navigation"
        className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted/60 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-muted/60"
      >
        <VariantIcon name={value} className="size-[18px]" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="grid w-auto grid-cols-4 gap-0.5 p-1.5">
        {VARIANT_ICONS.map((name) => (
          <DropdownMenuItem
            key={name}
            aria-label={ICONS[name].label}
            title={ICONS[name].label}
            onClick={() => onChange(name)}
            className={cn(
              "grid size-8 place-items-center p-0",
              (value ?? "file") === name && "bg-muted text-foreground",
            )}
          >
            <VariantIcon name={name} />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
