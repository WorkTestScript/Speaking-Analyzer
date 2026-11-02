try {
  document.documentElement.dataset.theme = localStorage.getItem("speaking-analyzer-theme") || "dark";
} catch {
  document.documentElement.dataset.theme = "dark";
}
