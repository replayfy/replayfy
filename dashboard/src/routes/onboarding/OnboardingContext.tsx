import { createContext, useContext, useState, type ReactNode } from "react";

/** Draft carried across the onboarding steps (nothing persists it in the
 *  prototype — each screen was independent). region is the UI id 'us'|'eu'. */
type OnboardingCtx = {
  name: string;
  slug: string;
  region: string;
  workspaceId: number | null;
  apiKey: string | null;
  setName: (n: string) => void;
  setRegion: (r: string) => void;
  setCreated: (workspaceId: number, apiKey?: string | null) => void;
  setApiKey: (k: string | null) => void;
};

const Ctx = createContext<OnboardingCtx | null>(null);

const slugify = (n: string) =>
  n
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "workspace";

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [name, setName] = useState("");
  const [region, setRegion] = useState("us");
  const [workspaceId, setWorkspaceId] = useState<number | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const setCreated = (id: number, key?: string | null) => {
    setWorkspaceId(id);
    if (key !== undefined) setApiKey(key);
  };
  return (
    <Ctx.Provider
      value={{
        name,
        slug: slugify(name),
        region,
        workspaceId,
        apiKey,
        setName,
        setRegion,
        setCreated,
        setApiKey,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useOnboarding(): OnboardingCtx {
  const c = useContext(Ctx);
  if (!c)
    throw new Error("useOnboarding must be used within OnboardingProvider");
  return c;
}
