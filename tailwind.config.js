import plugin from "tailwindcss/plugin";

export default {
  content: [
    "./app/**/*.{js,ts,jsx,tsx}",
    "./pages/**/*.{js,ts,jsx,tsx}",
    "./components/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-inter)", "Inter", "sans-serif"],
      },
      colors: {
        "mw-blue": "#ff0000",
        "mw-purple": "#00ff00",
        "sm-red": "#0000ff",
      },
    },
  },
};
