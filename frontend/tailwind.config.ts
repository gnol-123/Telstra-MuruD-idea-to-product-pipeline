import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#04070a",
        panel: "#0b0f13",
        panel2: "#0e1318",
        border: "rgba(255,255,255,0.08)",
        accent: "#22e0f0",
        text: "#e8ecee",
        muted: "rgba(255,255,255,0.45)",
      },
      fontFamily: {
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
        sans: ["Inter", "-apple-system", "BlinkMacSystemFont", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
