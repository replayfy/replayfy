/**
 * Workspace slug normalisation. Shared because the availability check, the
 * create path and the OAuth signup path must all agree on what a given name
 * turns into — two slugifiers would drift and hand users a "✓ available"
 * badge for a slug the create then rejects.
 */

/** Lowercase, non-alphanumerics to single dashes, trimmed. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "workspace"
  );
}

/** slugify + a 6-char random suffix, for slugs nobody gets to pick or see. */
export function uniqueSlug(name: string): string {
  return `${slugify(name)}-${Math.random().toString(36).slice(2, 8)}`;
}
