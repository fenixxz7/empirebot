/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: {
          950: "#070D1F",
          900: "#0B1430",
          800: "#0F1B40",
          700: "#152352",
          600: "#1B2C66",
        },
        accent: {
          DEFAULT: "#3B82F6",
          soft: "#1E3A8A",
        },
        ok: "#22C55E",
        warn: "#F59E0B",
        danger: "#EF4444",
      },
      fontFamily: {
        display: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
      boxShadow: {
        glow: "0 0 24px rgba(59,130,246,.25)",
        glowRed: "0 0 32px rgba(239,68,68,.35)",
      },
    },
  },
  plugins: [],
};
