/**
 * Tiny classNames joiner — filters out falsy values so conditional Tailwind
 * classes read cleanly: cn("base", isActive && "bg-line-2", err && "text-red").
 */
export type ClassValue = string | number | false | null | undefined;

export function cn(...parts: ClassValue[]): string {
  let out = "";
  for (const p of parts) {
    if (!p && p !== 0) continue;
    out += (out ? " " : "") + p;
  }
  return out;
}
