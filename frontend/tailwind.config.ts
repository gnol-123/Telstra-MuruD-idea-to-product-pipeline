import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Big Stone (page) / Blue Ribbon (brand blue) / Merino (text) redesign.
        bg: "#0A0F24",
        panel: "#131A35",
        panel2: "#1B2350",
        modal: "#131A35",
        border: "rgba(255,255,255,0.09)",
        // Solid button fills — pairs with white text.
        primary: "#0D54FF",
        // Text, lines, borders and other highlights — #0D54FF is too dark to
        // read as small text on a dark background, so highlights get the
        // lighter tint instead.
        accent: "#5C8DFF",
        // Stale-context warnings (was amber).
        amber: "#F44E1A",
        // Teams — unchanged, fits Telstra's multi-colour set.
        green: "#7ee787",
        text: "#F5EDE2",
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
