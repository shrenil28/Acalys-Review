/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Canvas + chrome — sampled from the CodeRabbit app (oklch, 305° hue).
        canvas: "var(--cr-canvas)",
        shell: "var(--cr-shell)",
        surface: "var(--cr-surface)",
        "surface-raised": "var(--cr-surface-raised)",
        line: "var(--cr-line)",
        "line-strong": "var(--cr-line-strong)",

        fg: "var(--cr-fg)",
        "fg-muted": "var(--cr-fg-muted)",
        "fg-subtle": "var(--cr-fg-subtle)",
        "fg-faint": "var(--cr-fg-faint)",

        brand: {
          DEFAULT: "var(--cr-brand)",
          soft: "var(--cr-brand-soft)",
          border: "var(--cr-brand-border)",
        },

        ok: "var(--cr-ok)",
        warn: "var(--cr-warn)",
        danger: "var(--cr-danger)",
        info: "var(--cr-info)",
        purple: "var(--cr-purple)",
      },
      fontFamily: {
        sans: ["Geist", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["Geist Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      borderRadius: {
        lg: "0.5rem",
        md: "0.375rem",
        sm: "0.25rem",
      },
      boxShadow: {
        card: "rgba(18, 16, 20, 0.8) 0px 1px 2px 0px",
        pop: "rgba(10, 10, 10, 0.16) 0px 12px 30px 0px, rgba(10, 10, 10, 0.12) 0px 2px 3px 0px",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.97)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        twinkle: {
          "0%, 100%": { opacity: "0", transform: "scale(0.6)" },
          "50%": { opacity: "1", transform: "scale(1)" },
        },
      },
      animation: {
        "fade-in": "fade-in 160ms ease-out",
        "scale-in": "scale-in 120ms ease-out",
        shimmer: "shimmer 1.6s infinite",
        twinkle: "twinkle 3.2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
