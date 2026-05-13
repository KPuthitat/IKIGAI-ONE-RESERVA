// น้องฮูก — IKIGAI OS mascot.
//
// Renders the actual owl PNG the owner provided (saved to
// /public/owl-mascot.png). The `mood` prop is kept on the API
// surface so existing call sites stay valid, but with a single
// source image every mood renders the same picture — moods are
// now communicated by the surrounding UI (banner colour, badge
// text, etc.) rather than the owl itself.
//
// We use plain <img> (not next/image) on purpose:
//   1. The mascot appears at many small sizes; next/image's
//      generated <img srcset> + sizes attributes don't save much
//      bandwidth here and add layout overhead.
//   2. The PNG is already small (< 50KB at 256×256).
//   3. Keeps the component a server-safe leaf — no client/runtime
//      dependency on next/image.

import * as React from "react";

export type OwlMood = "sleepy" | "smile" | "wink" | "thinking";

export default function OwlMascot({
  size = 96,
  mood,
  showCoffee = true,
  className,
  ariaLabel
}: {
  size?: number;
  mood?: OwlMood;
  /** Kept for prop compatibility — ignored now that the mascot is
   *  a single PNG. */
  showCoffee?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  // Aspect ratio of the source PNG is roughly 1:1 (square-ish);
  // we draw the box square and let the image self-center.
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src="/owl-mascot.png"
      alt={ariaLabel ?? "น้องฮูก"}
      width={size}
      height={size}
      style={{
        width: size,
        height: size,
        objectFit: "contain",
        // Light drop-shadow so the mascot reads against any
        // background colour. Doesn't add a circle/frame.
        filter: "drop-shadow(0 4px 8px rgba(0,0,0,0.12))"
      }}
      data-mood={mood}
      className={className}
      draggable={false}
    />
  );
}
