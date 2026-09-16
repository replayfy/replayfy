import type { OAuthProvider } from "@/api/endpoints";

type OAuthRowProps = { verb: string; onProvider?: (p: OAuthProvider) => void };

/* Side-by-side provider buttons — same height, border and centered text as
   every other control in the auth column. */
export function OAuthRow({ verb, onProvider }: OAuthRowProps) {
  return (
    <div className="av-oauth">
      <button className="av-btn ghost" onClick={() => onProvider?.("google")}>
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
        {verb} with Google
      </button>
      <button className="av-btn ghost" onClick={() => onProvider?.("github")}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 0C3.6 0 0 3.6 0 8c0 3.5 2.3 6.5 5.5 7.6.4.1.5-.2.5-.4v-1.4c-2.2.5-2.7-1-2.7-1-.4-.9-.9-1.2-.9-1.2-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.9.9 2.3.7.1-.5.3-.9.5-1.1-1.8-.2-3.6-.9-3.6-4 0-.9.3-1.6.8-2.1-.1-.2-.4-1 .1-2.1 0 0 .7-.2 2.2.8a7.5 7.5 0 0 1 4 0c1.5-1 2.2-.8 2.2-.8.5 1.1.2 1.9.1 2.1.5.5.8 1.2.8 2.1 0 3.1-1.8 3.8-3.6 4 .3.3.6.8.6 1.6v2.4c0 .2.1.5.5.4A8 8 0 0 0 16 8c0-4.4-3.6-8-8-8z" />
        </svg>
        {verb} with GitHub
      </button>
    </div>
  );
}
