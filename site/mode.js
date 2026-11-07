// Runs before the page paints, so a visitor who chose public mode never sees the terminal flash first.
// ?mode=public (or ?mode=dev) in a link wins, then the visitor's last choice, then dev.
(() => {
  let mode = new URLSearchParams(location.search).get("mode");
  try {
    if (mode === "dev" || mode === "public") localStorage.setItem("tare-mode", mode);
    else mode = localStorage.getItem("tare-mode");
  } catch {}
  if (mode === "public") document.documentElement.dataset.mode = "public";
})();
