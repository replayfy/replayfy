import { useEffect, useState, type ReactNode } from "react";
import { Auth, type OAuthProvider } from "@/api/endpoints";

type OAuthRowProps = { verb: string; onProvider?: (p: OAuthProvider) => void };

const LABEL: Record<OAuthProvider, string> = {
  google: "Google",
  github: "GitHub",
  gitlab: "GitLab",
};

const ICON: Record<OAuthProvider, ReactNode> = {
  google: (
    <svg width="15" height="15" viewBox="0 0 18 18">
      <path
        fill="#4285F4"
        d="M17.6 9.2c0-.6-.1-1.2-.2-1.8H9v3.4h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.5z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.5-1.8.9-3.1.9-2.4 0-4.4-1.6-5.1-3.8H.9v2.3A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.9 10.7a5.4 5.4 0 0 1 0-3.4V5H.9a9 9 0 0 0 0 8z"
      />
      <path
        fill="#EA4335"
        d="M9 3.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 .9 5l3 2.3C4.6 5.2 6.6 3.6 9 3.6z"
      />
    </svg>
  ),
  github: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 0C3.6 0 0 3.6 0 8c0 3.5 2.3 6.5 5.5 7.6.4.1.5-.2.5-.4v-1.4c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.5 7.5 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.5 1.1.2 1.9.1 2.1.5.5.8 1.2.8 2.1 0 3.1-1.8 3.8-3.6 4 .3.3.6.8.6 1.6v2.4c0 .2.1.5.5.4A8 8 0 0 0 16 8c0-4.4-3.6-8-8-8z" />
    </svg>
  ),
  gitlab: (
    <svg width="15" height="15" viewBox="0 0 16 16">
      <path fill="#E24329" d="M8 14.6 10.8 6H5.2z" />
      <path fill="#FC6D26" d="M8 14.6 5.2 6H1.3z" />
      <path fill="#FCA326" d="M1.3 6 .5 8.6c-.1.2 0 .5.2.6L8 14.6z" />
      <path fill="#E24329" d="M1.3 6h3.9L3.5.8c-.1-.3-.5-.3-.6 0z" />
      <path fill="#FC6D26" d="M8 14.6 10.8 6h3.9z" />
      <path fill="#FCA326" d="M14.7 6l.8 2.6c.1.2 0 .5-.2.6L8 14.6z" />
      <path fill="#E24329" d="M14.7 6h-3.9l1.7-5.2c.1-.3.5-.3.6 0z" />
    </svg>
  ),
};

/* Social-login buttons — one per provider CONFIGURED on this server (the backend
   only lists a provider once its CLIENT_ID + CLIENT_SECRET are set). A self-host
   with no OAuth configured renders nothing at all — including the "Or" divider —
   so the auth form stays a clean single column instead of offering buttons that
   would 400 on click. Same height/border/centered text as the other controls. */
export function OAuthRow({ verb, onProvider }: OAuthRowProps) {
  const [providers, setProviders] = useState<OAuthProvider[] | null>(null);

  useEffect(() => {
    let alive = true;
    Auth.oauthProviders()
      .then((r) => alive && setProviders(r.data.providers))
      .catch(() => alive && setProviders([]));
    return () => {
      alive = false;
    };
  }, []);

  // `null` = still loading → render nothing rather than flash then hide.
  if (!providers || providers.length === 0) return null;

  return (
    <>
      <div className="av-or">Or</div>
      <div className="av-oauth">
        {providers.map((p) => (
          <button
            key={p}
            className="av-btn ghost"
            onClick={() => onProvider?.(p)}
          >
            {ICON[p]} {verb} with {LABEL[p]}
          </button>
        ))}
      </div>
    </>
  );
}
