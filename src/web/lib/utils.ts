import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Size of a string once encoded as UTF-8, which is what travels over the wire. */
export function byteLength(text: string): number {
  return new Blob([text]).size;
}

export function formatRelativeTime(epochMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(epochMs).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : pluralForm}`;
}

export function looksLikeUrl(value: string): boolean {
  return /^https?:\/\/[^\s/]+\.[^\s]+|^https?:\/\/localhost[:/]?/.test(value.trim());
}

/** Whether the keystroke happened while typing into a field. */
export function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
/** The ⌘ or Ctrl label for keyboard hints. */
export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";

/** Up to two initials for an avatar. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts.at(-1)] : [parts[0]];
  return letters.map((part) => part?.[0]?.toUpperCase() ?? "").join("") || "?";
}
