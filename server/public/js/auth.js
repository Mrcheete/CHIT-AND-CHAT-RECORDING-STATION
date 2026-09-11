// Include on every page except login.html: bounces to the login page if
// there's no valid session, and wires up any "Log out" link on the page.
// The API itself also rejects unauthenticated requests (this is just so a
// logged-out teacher sees a login form instead of a broken, empty page).
(async function guard() {
  try {
    const res = await fetch("/api/me", { credentials: "same-origin" });
    if (!res.ok) throw new Error("not logged in");
  } catch {
    window.location.href = "login.html";
  }
})();

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-logout]").forEach((el) => {
    el.addEventListener("click", async (e) => {
      e.preventDefault();
      await fetch("/api/logout", { method: "POST", credentials: "same-origin" });
      window.location.href = "login.html";
    });
  });
});
