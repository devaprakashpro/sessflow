/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        vault: {
          bg: '#0f1115',
          panel: '#171a21',
          card: '#1d212b',
          border: '#2a2f3a',
          accent: '#6366f1',
          accent2: '#22d3ee',
          muted: '#8b93a7',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
