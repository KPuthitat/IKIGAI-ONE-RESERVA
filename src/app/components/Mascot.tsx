// Commissioned cartoon mascot (owner 2026-10-12) — transparent WebP poses in
// /public/mascot. Plain <img> like OwlMascot: small leaf, server-safe, files
// are ~20 KB each. Decorative by default (alt="").
import * as React from "react";

export type MascotPose = "thumbs" | "wai" | "mortar" | "sign" | "drumstick";

export default function Mascot({
  pose,
  size = 96,
  className,
  alt = ""
}: {
  pose: MascotPose;
  size?: number;
  className?: string;
  alt?: string;
}) {
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={`/mascot/${pose}.webp`}
      alt={alt}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className={className}
      style={{ width: size, height: size, objectFit: "contain" }}
    />
  );
}
