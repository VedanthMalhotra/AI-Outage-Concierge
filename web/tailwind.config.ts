import type { Config } from "tailwindcss";
import { resolve } from "node:path";

/**
 * AEP brand standards encoded as the Tailwind theme.
 *
 * Palette + type matched to aep.com: white page, clean white cards with light
 * borders, AEP red (#C22823) used sparingly for buttons/links/accents, dark
 * slate text, a cool-gray band behind cards, small radii and soft low shadows.
 * Band colours are always paired with text, never colour alone.
 *
 * Content globs are resolved against this file's directory (web/) so they work
 * regardless of the process working directory or the Vite root.
 */
const here = __dirname;
export default {
  content: [resolve(here, "index.html"), resolve(here, "src/**/*.{ts,js}")],
  theme: {
    extend: {
      colors: {
        aep: {
          // surfaces
          bg: "#ffffff",
          panel: "#ffffff",
          "panel-2": "#f5f6f8",
          band: "#f5f6f8",
          border: "#e3e6ea",
          // text
          text: "#2b2b2b",
          muted: "#666b72",
          // AEP red family
          accent: "#c22823",
          "accent-dark": "#9e1f1b",
          "accent-ink": "#a7211c",
          "accent-soft": "#fbeceb",
          // risk bands (tuned to read on white)
          "band-low": "#15803d",
          "band-moderate": "#b45309",
          "band-high": "#c2410c",
          "band-veryhigh": "#b91c1c",
          safety: "#b45309",
          emergency: "#c22823",
        },
      },
      borderRadius: {
        aep: "6px",
      },
      boxShadow: {
        aep: "0 1px 3px rgba(43,43,43,0.08), 0 1px 2px rgba(43,43,43,0.06)",
        "aep-head": "0 2px 4px rgba(43,43,43,0.05)",
      },
      fontFamily: {
        sans: [
          "Segoe UI",
          "system-ui",
          "-apple-system",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
      maxWidth: {
        layout: "1500px",
      },
    },
  },
  plugins: [],
} satisfies Config;
