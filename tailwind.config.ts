import type { Config } from "tailwindcss";

// IKIGAI OS — CI palette matching the Payroll app
const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        // The CSS variable is injected by next/font/local in
        // src/app/layout.tsx — Tailwind's `font-sans` class therefore
        // resolves to the next/font-managed family at runtime,
        // gaining the preload + size-adjust optimisations for free.
        sans: [
          "var(--font-lineseed)",
          "ui-sans-serif",
          "system-ui",
          "sans-serif"
        ],
        // 2026-05: `font-mono` previously resolved to Tailwind's
        // default ui-monospace stack (Menlo/Consolas/etc.), which
        // overrode LINE Seed Sans TH for every numeric display —
        // payslip totals, ref numbers, money values. Owner noticed
        // the inconsistency on the admin payslip pages. Repointing
        // mono → LineSeed gives us back the brand font; columnar
        // alignment is still achieved via the `tabular-nums` utility
        // (font-variant-numeric: tabular-nums) at each call site.
        mono: [
          "var(--font-lineseed)",
          "ui-sans-serif",
          "system-ui",
          "sans-serif"
        ]
      },
      colors: {
        // Primary accent — warm caramel/amber, matched to น้องฮูก on the
        // login page (owner 2026-06-03, "ปรับสี CI ให้เหมือนน้องฮูก").
        // Replaces the old red-pink #e94560. DEFAULT is dark enough for
        // white button text + small text-brand to stay legible.
        // Values come from CSS variables (src/app/globals.css) so a UI theme
        // (html[data-ui]) can restyle the whole app without touching call
        // sites. <alpha-value> keeps bg-brand/10 style opacity working.
        brand: {
          DEFAULT: "rgb(var(--brand) / <alpha-value>)",
          dark: "rgb(var(--brand-dark) / <alpha-value>)",
          light: "rgb(var(--brand-light) / <alpha-value>)"
        },
        accent: "rgb(var(--accent) / <alpha-value>)",
        // Header / sidebar gradient stops — warm espresso brown, mirroring
        // the owl's outline + coffee cup (was deep navy). White text on it
        // stays high-contrast. Used everywhere via bg-ink-gradient.
        ink: {
          900: "rgb(var(--ink-900) / <alpha-value>)",
          800: "rgb(var(--ink-800) / <alpha-value>)",
          700: "rgb(var(--ink-700) / <alpha-value>)"
        }
      },
      backgroundImage: {
        "ink-gradient": "var(--grad-ink)",
        // Header bar gradient — see --grad-header in globals.css.
        "coffee-gradient": "var(--grad-header)"
      },
      boxShadow: {
        // Softened 2026-08 (owner redesign) — the old heavy 60px/.3 drop
        // shadow read as "loud"; PEAK-style soft elevation instead. Warm
        // espresso-tinted rgba so it sits right on the cream surfaces.
        card: "var(--shadow-card)",
        "card-lg": "var(--shadow-card-lg)"
      }
    }
  },
  plugins: []
};
export default config;
