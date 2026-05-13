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
        ]
      },
      colors: {
        // primary accent (red-pink)
        brand: {
          DEFAULT: "#e94560",
          dark: "#c8203c",
          light: "#ff6b85"
        },
        // deep navy gradient stops
        ink: {
          900: "#0f3460",
          800: "#16213e",
          700: "#1a1a2e"
        }
      },
      backgroundImage: {
        "ink-gradient":
          "linear-gradient(160deg, #1a1a2e 0%, #16213e 60%, #0f3460 100%)"
      },
      boxShadow: {
        card: "0 20px 60px rgba(0,0,0,.3)"
      }
    }
  },
  plugins: []
};
export default config;
