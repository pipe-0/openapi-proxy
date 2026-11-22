// Applies the saved color scheme before the first paint, so a dark-mode user
// never sees a white flash. Kept as a file (not inline) so the page can run
// under a Content-Security-Policy without 'unsafe-inline'. src/web/lib/theme.ts
// owns the setting after that and reads the same key.
(() => {
  try {
    const choice = localStorage.getItem("openapi-proxy:theme") || "system";
    const dark =
      choice === "dark" ||
      (choice === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  } catch (_) {}
})();
