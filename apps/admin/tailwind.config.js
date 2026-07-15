import typography from "@tailwindcss/typography";
import containerQueries from "@tailwindcss/container-queries";

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{html,js,jsx,ts,tsx}"],
  theme: {
    extend: {
      typography: {
        DEFAULT: {
          css: {
            pre: false,
            code: false,
            "pre code": false,
            "code::before": false,
            "code::after": false
          }
        }
      },
      padding: {
        "safe-bottom": "env(safe-area-inset-bottom)"
      },
      transitionProperty: {
        width: "width"
      }
    }
  },
  plugins: [typography, containerQueries]
};
