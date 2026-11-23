/**
 * The icons a variant can have in the navigation, by name. A variant is made
 * for an audience, and a small picture tells them apart faster than a name
 * does.
 */
export const VARIANT_ICONS = [
  "file",
  "book",
  "code",
  "globe",
  "lock",
  "users",
  "bot",
  "terminal",
  "package",
  "rocket",
  "flask",
  "shield",
  "star",
  "zap",
  "layers",
  "plug",
] as const;

export type VariantIconName = (typeof VARIANT_ICONS)[number];

export function isVariantIcon(value: unknown): value is VariantIconName {
  return (VARIANT_ICONS as readonly unknown[]).includes(value);
}
