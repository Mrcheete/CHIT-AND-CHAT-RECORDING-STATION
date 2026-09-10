// Thin wrapper around fetch() for the backend API. Same origin as the front
// end now, so there's no server address or passcode to configure — the
// session cookie set by /api/login rides along automatically.
async function ccApiFetch(path, options = {}) {
  return fetch(path, { ...options, credentials: "same-origin" });
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

window.CCApi = { fetch: ccApiFetch, json: ccApiJson };
