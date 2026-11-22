import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronsUpDownIcon, LogOutIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api, queries } from "@/lib/api";
import { queryClient } from "@/lib/query-client";
import { setTheme, type ThemeChoice, useTheme } from "@/lib/theme";
import { cn, initials } from "@/lib/utils";

export function Avatar({
  name,
  image,
  className,
}: {
  name: string;
  image?: string | null | undefined;
  className?: string;
}) {
  return image ? (
    <img
      src={image}
      alt=""
      referrerPolicy="no-referrer"
      className={cn("size-6 shrink-0 rounded-full object-cover", className)}
    />
  ) : (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-[10.5px] font-semibold",
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

export async function signOut(): Promise<void> {
  await api.signOut().catch(() => undefined);
  queryClient.clear();
  window.location.assign("/login");
}

/** Who is signed in, the color scheme, and the way out. Sits at the foot of the sidebar. */
export function UserMenu() {
  const me = useQuery(queries.me);
  const { choice } = useTheme();
  const leave = useMutation({ mutationFn: signOut });
  if (!me.data) return null;
  const { user } = me.data;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left outline-none hover:bg-foreground/5 focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-foreground/5"
        aria-label="Account"
      >
        <Avatar name={user.name} image={user.image} className="size-7" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] leading-4 font-medium">{user.name}</span>
          <span className="block truncate text-[11.5px] leading-4 text-muted-foreground">
            {user.email}
          </span>
        </span>
        <ChevronsUpDownIcon className="size-3.5 shrink-0 text-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Appearance</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={choice}
            onValueChange={(value) => setTheme(value as ThemeChoice)}
          >
            <DropdownMenuRadioItem value="system">
              <MonitorIcon /> System
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="light">
              <SunIcon /> Light
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">
              <MoonIcon /> Dark
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => leave.mutate()}>
          <LogOutIcon /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
