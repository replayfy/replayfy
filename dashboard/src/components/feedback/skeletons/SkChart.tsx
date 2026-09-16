import { Sk } from "./Sk";

type SkChartProps = { h?: number };

/* big chart block */
export function SkChart({ h = 240 }: SkChartProps) {
  return <div className="sk-chart" style={{ height: h }}><Sk w="100%" h="100%" r={12} /></div>;
}
