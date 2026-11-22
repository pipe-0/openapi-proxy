import { useSyncExternalStore } from "react";

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "openapi-proxy:theme";
// This module is also loaded on the server (it renders the landing page), where
// there is no window to ask.
const media =
  typeof window === "undefined" ? undefined : window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function read(): ThemeChoice {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function apply(): void {
  const choice = read();
  const dark = choice === "dark" || (choice === "system" && media?.matches === true);
  document.documentElement.classList.toggle("dark", dark);
  for (const listener of listeners) listener();
}

if (media) {
  media.addEventListener("change", apply);
  // Another tab changed the setting.
  window.addEventListener("storage", (event) => {
    if (event.key === KEY) apply();
  });
}

export function setTheme(choice: ThemeChoice): void {
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Storage is unavailable (private mode): the choice lasts for this page only.
  }
  apply();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The user's setting, and what it currently resolves to. */
export function useTheme(): { choice: ThemeChoice; resolved: "light" | "dark" } {
  const choice = useSyncExternalStore(subscribe, read, () => "system" as const);
  const resolved = useSyncExternalStore(
    subscribe,
    () => (document.documentElement.classList.contains("dark") ? "dark" : "light"),
    () => "light" as const,
  );
  return { choice, resolved };
}
