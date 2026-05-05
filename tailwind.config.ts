import type { Config } from "tailwindcss";

// IKIGAI ONE — CI palette matching the Payroll app
const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '"LINE Seed Sans TH"',
          '"LINE Seed Sans"',
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
