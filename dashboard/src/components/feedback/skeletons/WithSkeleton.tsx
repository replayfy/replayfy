import { useState, useEffect } from "react";
import type { ReactNode } from "react";

type WithSkeletonProps = {
  ms?: number;
  skeleton?: ReactNode;
  children?: ReactNode;
};

/* Delays children by `ms`, showing a skeleton first — simulates fetch. */
export function WithSkeleton({ ms = 600, skeleton, children }: WithSkeletonProps): ReactNode {
  const [ready, setReady] = useState(false);
  useEffect(() => { const t = setTimeout(() => setReady(true), ms); return () => clearTimeout(t); }, []);
  return ready ? children : skeleton;
}
