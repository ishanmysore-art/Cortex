/**
 * Merge class names, filtering out falsy values.
 * Keeps us dependency-free for now; we can add tailwind-merge later if conflicts arise.
 */
export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(" ");
}
