import { Outlet } from "react-router-dom";
import { OnboardingProvider } from "./OnboardingContext";

/** Wraps the onboarding step routes so they share the draft (name/region/…). */
export function OnboardingLayout() {
  return (
    <OnboardingProvider>
      <Outlet />
    </OnboardingProvider>
  );
}
