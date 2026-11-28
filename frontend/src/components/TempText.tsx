import type { SensorKind } from "../lib/thermals";
import { useTempColor } from "../store/thermalStore";

/** A temperature coloured green / orange / red by the limits of its sensor kind (Settings › Thermal Sensors). */
export function TempText({ c, kind, unit = " °C", empty = "—", className = "" }: { c: number | null | undefined; kind: SensorKind; unit?: string; empty?: string | null; className?: string }) {
  const tc = useTempColor();
  if (c == null) return empty;
  return <span className={`tabular-nums ${tc.text(c, kind)} ${className}`}>{c.toFixed(0)}{unit}</span>;
}
