export default {
  plugins: {
    // Tailwind CSS muss als ERSTES Plugin geladen werden
    // Wir verwenden die korrekte Plugin-Liste, die NICHT auf './nesting' zugreift.
    tailwindcss: {},
    autoprefixer: {},
  },
}