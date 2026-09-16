/* ============================================================================
   Who a session belongs to — resolved ONCE, here.

   Every surface that names an end user reads this. It used to be inlined at a
   dozen call sites, which is why they disagreed: the recordings row counted a
   user with an email but no name as identified, while the Users page rendered
   that same person as "Anonymous" and its Identified filter — which compared the
   rendered LABEL string — then filed them under Anonymous. Two pages, two
   answers, same row. One resolver is the fix; the ordering below is the cheap
   part.

   ORDER: name → email → "Anonymous", with email on a second line beneath a name.
   `name` is not a guess or a derivation: identify() is typed
   ({distinctId, email, name, plan, customProps}) and all five SDKs hoist `name`
   explicitly, so a name is a string a customer deliberately passed. The seed
   data's "Demo User 4" only reads as noise because the seeder chose boring
   names; a real "Jane Cooper" is the most scannable token on the row. Email
   isn't dropped — it was never rendered at all, and that was the actual bug.

   A CUSTOMER-SUPPLIED distinctId COUNTS. identify({distinctId: "tic-tac-toe-
   player"}) with no name and no email is still an identification — the reference
   makes that id the label outright (userId || userAnonymousId || "Anonymous
   User"), and we were calling those people Anonymous. It goes last, because it
   is a machine key and a human name or address beats it.

   The catch is that distinctId is ALSO where the synthetic ids live: the server
   falls back to the browser fingerprint and then to `anon_<sessionId>`
   (replay-persistence.service.ts:240-244). Those must never reach the screen.
   They are separable by prefix and only by prefix — the fingerprint is
   `"fp_" + djb2(...)` (replay-web-sdk/src/fingerprint.ts:66) and the session
   fallback is `anon_…`. Hence SYNTHETIC_ID. If a future ingest path invents a
   third unprefixed synthetic id, this leaks it, and the durable fix is a
   server-side `isIdentified` flag rather than a smarter regex here.

   WHAT IS DELIBERATELY NOT HERE:

   · No customProps key-sniffing (firstName / fullName / displayName / username).
     identify() has a typed `name`; a product that needs those should map them at
     the call site, not have the dashboard guess at key names.

   · The avatar hue is seeded from a stable id, never from the label. Seeding off
     the label re-colours a person the instant identify() lands mid-session,
     because their label flips from anonymous to their name.
   ========================================================================== */

export type IdentityLike = {
  distinctId?: string | null;
  email?: string | null;
  name?: string | null;
  initials?: string | null;
  /** Avatar URL from identify() (`picture`/`avatar` trait), URL-validated
   *  server-side. Rendered as the avatar image when present, else the initials
   *  glyph. */
  picture?: string | null;
};

export type Identity = {
  /** Did identify() actually run? Never re-derive this by comparing the label
   *  against "Anonymous" — that is the bug this replaces. */
  identified: boolean;
  /** Primary line. Always non-empty. */
  label: string;
  /** Second line, or null when there is nothing to add that the label lacks. */
  sub: string | null;
  /** Avatar text, or null → render the neutral glyph rather than inventing one
   *  from label[0] (which would print "A" for every anonymous user). */
  initials: string | null;
  /** Avatar image URL, or null. When set, surfaces render an <img> instead of the
   *  initials glyph. Dropped on public surfaces (like the email), so a share-link
   *  recipient never pulls a customer's end-user avatar. */
  picture: string | null;
  /** Avatar colour seed. Stable across an identify(); never the label. */
  hueSeed: string;
};

/** The reference implementation surfaces no id here — an anonymous row is a
 *  human-readable dead end, not a truncated internal key. We used to print
 *  "anon · ses_b6" (and "Anonymous · x", and "anon x", and "Session x"). The id
 *  is already on the player header for anyone who needs it. */
export const ANON_LABEL = "Anonymous";

const clean = (s?: string | null): string | null => {
  const t = s?.trim();
  return t ? t : null;
};

/** Web writes EndUser.email verbatim while the mobile SDKs lowercase it before
 *  send, so the column holds mixed case and the same person can render two ways.
 *  Normalising here is a render-time stopgap; the real fix is normalise-on-write
 *  plus a backfill. */
const mail = (s?: string | null): string | null => clean(s)?.toLowerCase() ?? null;

/** Server-minted, never customer-minted: the browser fingerprint (`fp_…`,
 *  fingerprint.ts:66) and the no-identity session fallback (`anon_…`,
 *  replay-persistence.service.ts:243-244). Neither is a person. */
const SYNTHETIC_ID = /^(fp_|anon_)/i;

/** A distinctId only when the customer chose it themselves. Also drops the case
 *  where it merely restates the email — the server uses the address AS the
 *  distinctId when identify() passes an email and no id (…service.ts:242), so
 *  otherwise every email-only user would render their address twice. */
const handleOf = (distinctId?: string | null, email?: string | null): string | null => {
  const d = clean(distinctId);
  if (!d || SYNTHETIC_ID.test(d)) return null;
  return d.toLowerCase() === (email ?? "") ? null : d;
};

const initialsFromName = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

/** Stored initials are derived from `name` ONLY, on both ingest paths, so they
 *  are NULL for precisely the email-only users this change makes visible. Split
 *  the local part so "jane.doe@acme.io" reads JD rather than a blank chip. */
const initialsFromEmail = (email: string): string | null => {
  const local = email.split("@")[0];
  const parts = local.split(/[._+-]+/).filter(Boolean);
  if (!parts.length) return null;
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : local.slice(0, 2)).toUpperCase();
};

/**
 * @param eu        the end user, or null/undefined when the session has none
 * @param seed      stable fallback for the avatar hue (session publicId, or the
 *                  EndUser id on user-scoped surfaces)
 * @param isPublic  a share page — reachable by anyone holding the URL. No
 *                  address leaves the authenticated app: the email is dropped
 *                  from the second line AND can never stand in as the label, so
 *                  an email-only user reads as "Anonymous" to a recipient. That
 *                  loses a little information on purpose. The alternative is
 *                  mailing a customer's end-user address to whoever opens the
 *                  link, which is not the sharer's to give away.
 */
export function resolveIdentity(
  eu: IdentityLike | null | undefined,
  seed: string,
  isPublic = false,
): Identity {
  const name = clean(eu?.name);
  const email = mail(eu?.email);
  const handle = handleOf(eu?.distinctId, email);
  const identified = !!(name || email || handle);

  /* Public surfaces show a NAME or nothing. Not the email, and not the handle
     either: a customer is free to pass an address as their distinctId, so
     allowing it here would reopen the same leak through the other door. */
  const label = isPublic
    ? name ?? ANON_LABEL
    : name ?? email ?? handle ?? ANON_LABEL;
  // Only ever the email, and only when the label isn't already showing it.
  const sub = !isPublic && identified && email && email !== label ? email : null;

  const initials =
    clean(eu?.initials)?.slice(0, 2).toUpperCase() ??
    (name ? initialsFromName(name) : null) ??
    // An email-only user has no stored initials, but on a public surface their
    // address isn't the label — deriving "JD" from jane.doe@ would put a piece
    // of it back on screen. Anonymous there means anonymous.
    (email && !isPublic ? initialsFromEmail(email) : null) ??
    (handle && !isPublic ? handle.slice(0, 2).toUpperCase() : null) ??
    null;

  return {
    identified,
    label,
    sub,
    initials,
    // Dropped on public surfaces, same as the email/handle: a shared recording
    // must not pull a customer's end-user avatar for whoever holds the link.
    picture: !isPublic ? (clean(eu?.picture) ?? null) : null,
    hueSeed: clean(eu?.distinctId) ?? seed,
  };
}
