import type { SlugStatus } from "@editor/components/slug-input";
import { isValidSlug } from "@openapi-proxy/core";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { SlugCheck } from "@/lib/api";

/** Check a slug as it is typed. Debounced, and cached per namespace. */
export function useSlugStatus(
  value: string,
  check: (slug: string) => Promise<SlugCheck>,
  scope: string,
  current?: string,
): SlugStatus {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), 250);
    return () => clearTimeout(timer);
  }, [value]);

  const result = useQuery({
    queryKey: ["slug-check", scope, debounced],
    queryFn: () => check(debounced),
    enabled: isValidSlug(debounced) && debounced !== current,
    staleTime: 5_000,
  });

  if (value === "") return "idle";
  if (!isValidSlug(value)) return "invalid";
  if (value === current) return "available";
  if (debounced !== value || result.isPending) return "checking";
  return result.data?.available ? "available" : "taken";
}
