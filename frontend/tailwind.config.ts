import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#000000",
        panel: "#0b0f13",
        panel2: "#0e1318",
        modal: "#080b0d",
        border: "rgba(255,255,255,0.09)",
        accent: "#22e0f0",
        amber: "#ffb74d",
        green: "#7ee787",
        text: "#e8ecee",
        muted: "rgba(255,255,255,0.4)",
      },
      fontFamily: {
        sans: ["Poppins", "system-ui", "-apple-system", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
