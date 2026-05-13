// น้องฮูก — IKIGAI OS mascot.
//
// Inline SVG so the owl scales crisp at any size and there's no
// extra HTTP request for a bitmap. Mood variants change the eye/
// eyebrow shapes only — body, ears, beak stay constant so the
// mascot reads the same character across moods.
//
//   sleepy  — droopy eyelids (default, matches the reference art)
//   smile   — happy squinted eyes (used on success states)
//   wink    — one eye closed (acknowledgement / chatbot greeting)
//   thinking — eyebrows raised + small "?" floats above (FAQ search)
//
// Set showCoffee={true} (default) to render the coffee cup at the
// owl's feet. Drop it for the bare bust on tight chips.

import * as React from "react";

export type OwlMood = "sleepy" | "smile" | "wink" | "thinking";

export default function OwlMascot({
  size = 96,
  mood = "sleepy",
  showCoffee = true,
  className,
  ariaLabel
}: {
  size?: number;
  mood?: OwlMood;
  showCoffee?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  // Eye shapes per mood.
  const renderEyes = () => {
    switch (mood) {
      case "smile":
        // Squinted ^^ — two curves
        return (
          <g stroke="#3d2817" strokeWidth={2.5} strokeLinecap="round" fill="none">
            <path d="M30 48 Q38 42 46 48" />
            <path d="M54 48 Q62 42 70 48" />
          </g>
        );
      case "wink":
        // Left squinted, right open
        return (
          <g>
            <path d="M30 48 Q38 42 46 48"
              stroke="#3d2817" strokeWidth={2.5} strokeLinecap="round" fill="none" />
            <ellipse cx="62" cy="48" rx="6.5" ry="6.5" fill="#ffffff" />
            <ellipse cx="62" cy="48" rx="3" ry="3" fill="#3d2817" />
          </g>
        );
      case "thinking":
        return (
          <g>
            {/* eyebrows raised */}
            <path d="M30 41 Q38 38 46 41" stroke="#5d3a1f" strokeWidth={2} fill="none" />
            <path d="M54 41 Q62 38 70 41" stroke="#5d3a1f" strokeWidth={2} fill="none" />
            <ellipse cx="38" cy="48" rx="6.5" ry="6.5" fill="#ffffff" />
            <ellipse cx="62" cy="48" rx="6.5" ry="6.5" fill="#ffffff" />
            <ellipse cx="38" cy="49" rx="3" ry="3" fill="#3d2817" />
            <ellipse cx="62" cy="49" rx="3" ry="3" fill="#3d2817" />
            {/* "?" hovering top-right */}
            <text x="80" y="22" fontSize="14" fontWeight="bold" fill="#5d3a1f">?</text>
          </g>
        );
      case "sleepy":
      default:
        // Droopy eyelids covering top half — reference art
        return (
          <g>
            <ellipse cx="38" cy="50" rx="7" ry="6" fill="#ffffff" />
            <ellipse cx="62" cy="50" rx="7" ry="6" fill="#ffffff" />
            {/* upper eyelid arcs */}
            <path d="M30 47 Q38 51 46 47 L46 44 Q38 39 30 44 Z" fill="#a5814f" />
            <path d="M54 47 Q62 51 70 47 L70 44 Q62 39 54 44 Z" fill="#a5814f" />
            <ellipse cx="38" cy="52" rx="3" ry="2.5" fill="#3d2817" />
            <ellipse cx="62" cy="52" rx="3" ry="2.5" fill="#3d2817" />
          </g>
        );
    }
  };

  return (
    <svg
      viewBox="0 0 100 110"
      width={size}
      height={size}
      role={ariaLabel ? "img" : "presentation"}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      className={className}
    >
      {/* Ear tufts — pointed crowns rising from the sides of the head.
          Drawn before the body so the body overlaps them and only the
          tips show. */}
      <path d="M22 32 Q19 12 30 22 L35 36 Z" fill="#c8a574" />
      <path d="M78 32 Q81 12 70 22 L65 36 Z" fill="#c8a574" />

      {/* Body — broad teardrop. */}
      <path
        d="M50 18
           C 25 18, 16 50, 18 72
           C 20 92, 35 100, 50 100
           C 65 100, 80 92, 82 72
           C 84 50, 75 18, 50 18 Z"
        fill="#c8a574"
      />
      {/* Subtle belly highlight */}
      <ellipse cx="50" cy="70" rx="20" ry="22" fill="#d8b888" opacity="0.6" />

      {renderEyes()}

      {/* Beak — small triangle below eyes */}
      <path d="M47 60 L53 60 L50 67 Z" fill="#5d3a1f" />

      {/* Optional coffee + feet — anchored at the bottom */}
      {showCoffee && (
        <g>
          {/* Two feet sticking out */}
          <ellipse cx="38" cy="100" rx="5" ry="2" fill="#5d3a1f" />
          <ellipse cx="62" cy="100" rx="5" ry="2" fill="#5d3a1f" />
          {/* Steam */}
          <path d="M48 76 Q46 72 49 70 Q52 72 49 76"
            stroke="#5d3a1f" strokeWidth={1.5} fill="none" opacity="0.7" />
          {/* Cup body */}
          <path d="M40 82 L60 82 L57 96 L43 96 Z" fill="#3d2817" />
          {/* Cup handle */}
          <path d="M60 85 Q66 87 64 92" stroke="#3d2817" strokeWidth={2} fill="none" />
        </g>
      )}
    </svg>
  );
}
