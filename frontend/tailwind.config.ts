import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#000000",
        panel: "#0b0f13",
        panel2: "#0e1318",
        border: "rgba(255,255,255,0.09)",
        accent: "#22e0f0",
        amber: "#ffb74d",
        green: "#7ee787",
        text: "#e8ecee",
        muted: "rgba(255,255,255,0.4)",
      },
    },
  },
  plugins: [],
};

export default config;
