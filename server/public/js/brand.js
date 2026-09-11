// Brand kit: loads saved colours/logo from localStorage and applies them as
// CSS custom properties, plus renders the shared header/nav into #app-header.
const BRAND_KEY = "cc_brand_kit_v1";

const DEFAULT_BRAND = {
  name: "Chit & Chat",
  primary: "#5642a0",   // brand-600 — same purple as the School Manager / Connect apps
  secondary: "#6fd6c6", // mint-500 — same mint accent used across the other apps
  accent: "#a99ae6",    // brand-300 — a lighter purple for highlights
  ink: "#1a1433",        // brand-900 — the same dark ink used site-wide
  logo: "assets/logo.svg",
};

function loadBrand() {
  try {
    const saved = JSON.parse(localStorage.getItem(BRAND_KEY));
    return { ...DEFAULT_BRAND, ...(saved || {}) };
  } catch {
    return { ...DEFAULT_BRAND };
  }
}

function saveBrand(brand) {
  localStorage.setItem(BRAND_KEY, JSON.stringify(brand));
}

function applyBrand(brand) {
  const root = document.documentElement.style;
  root.setProperty("--brand-primary", brand.primary);
  root.setProperty("--brand-secondary", brand.secondary);
  root.setProperty("--brand-accent", brand.accent);
  root.setProperty("--brand-ink", brand.ink);
  document.title = document.title.replace(/^Chit & Chat/, brand.name);
}

const NAV_ITEMS = [
  { href: "index.html", label: "Dashboard" },
  { href: "studio.html", label: "Record" },
  { href: "editor.html", label: "Editor" },
  { href: "library.html", label: "Library" },
  { href: "students.html", label: "Students" },
  { href: "settings.html", label: "Brand Kit" },
];

function renderHeader(activePage) {
  const mount = document.getElementById("app-header");
  if (!mount) return;
  const brand = loadBrand();
  applyBrand(brand);

  const links = NAV_ITEMS.map(
    (item) =>
      `<a href="${item.href}" class="${item.href === activePage ? "active" : ""}">${item.label}</a>`
  ).join("");

  mount.innerHTML = `
    <div class="container">
      <a href="index.html" class="brand">
        <img src="${brand.logo}" alt="${brand.name} logo" onerror="this.style.display='none'">
        ${brand.name}
      </a>
      <nav>${links}<a href="#" data-logout>Log out</a></nav>
    </div>
  `;
}

function toast(message, ms = 2600) {
  let el = document.getElementById("cc-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "cc-toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), ms);
}

window.CCBrand = { loadBrand, saveBrand, applyBrand, renderHeader, toast, DEFAULT_BRAND };
