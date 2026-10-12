// Nong Plara reacting to a period-over-period change (owner 2026-10-12):
// sales up → thumbs-up, sales down → sitting glum, roughly flat → hands on hips.
import Mascot, { type MascotPose } from "./Mascot";

/** ±2% counts as "flat" so tiny wobble does not flip the mood. */
export const TREND_FLAT_BAND = 2;

export function trendPose(pct: number | null | undefined): MascotPose | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct >= TREND_FLAT_BAND) return "thumbs";
  if (pct <= -TREND_FLAT_BAND) return "shock";
  return "proud";
}

export default function TrendMascot({ pct, size = 56, className, title }: { pct: number | null | undefined; size?: number; className?: string; title?: string }) {
  const pose = trendPose(pct);
  if (!pose) return null;
  const img = <Mascot pose={pose} size={size} className={title ? undefined : (className ?? "flex-shrink-0")} />;
  // `title` is the hover/long-press explanation of what the mood is based on.
  return title ? <span title={title} className={className ?? "flex-shrink-0"} style={{ display: "inline-flex" }}>{img}</span> : img;
}
