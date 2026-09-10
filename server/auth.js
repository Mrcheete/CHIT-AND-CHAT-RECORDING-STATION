// Single shared-secret auth: this is a one-teacher tool, not a multi-user
// SaaS, so a passcode checked as a Bearer token is enough to stop randoms
// on the internet from emailing your students or burning your OpenAI
// credits on /api/send and /api/translate. Set STUDIO_PASSCODE in
// server/.env to turn it on.
function requireAuth(req, res, next) {
  const passcode = process.env.STUDIO_PASSCODE;
  if (!passcode) return next(); // dev mode: no passcode configured, wide open

  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token !== passcode) {
    return res.status(401).json({ error: "unauthorized — set the studio passcode in Brand Kit / send it as a Bearer token" });
  }
  next();
}

module.exports = { requireAuth };
