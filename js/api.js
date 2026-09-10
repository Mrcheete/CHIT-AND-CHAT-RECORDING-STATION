// Thin wrapper around fetch() for the optional backend: adds the studio
// passcode (see settings.html) as a Bearer token on every call, and gives
// every page one place to point at a different server if needed.
const CC_API_BASE = localStorage.getItem("cc_api_base") || "http://localhost:8787";

function ccPasscode() {
  return localStorage.getItem("cc_passcode") || "";
}

async function ccApiFetch(path, options = {}) {
  const passcode = ccPasscode();
  const headers = { ...(options.headers || {}) };
  if (passcode) headers.Authorization = `Bearer ${passcode}`;
  return fetch(`${CC_API_BASE}${path}`, { ...options, headers });
}

async function ccApiJson(path, options = {}) {
  const res = await ccApiFetch(path, options);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

window.CCApi = { base: CC_API_BASE, fetch: ccApiFetch, json: ccApiJson, passcode: ccPasscode };
