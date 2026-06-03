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
        brand: {
          DEFAULT: "#a06820",
          dark: "#7a4f16",
          light: "#d6a14d"
        },
        // Header / sidebar gradient stops — warm espresso brown, mirroring
        // the owl's outline + coffee cup (was deep navy). White text on it
        // stays high-contrast. Used everywhere via bg-ink-gradient.
        ink: {
          900: "#4e351f",
          800: "#3a2716",
          700: "#281a0e"
        }
      },
      backgroundImage: {
        "ink-gradient":
          "linear-gradient(160deg, #281a0e 0%, #3a2716 60%, #4e351f 100%)"
      },
      boxShadow: {
        card: "0 20px 60px rgba(0,0,0,.3)"
      }
    }
  },
  plugins: []
};
export default config;
