// Single-teacher account auth: a signed, stateless session cookie
// (cookie-session, keyed by SESSION_SECRET) rather than a server-side
// session store — there's only ever one account today, so there's nothing
// to revoke server-side yet. See db.js for the teachers table and
// server.js for the /api/login, /api/logout, /api/me routes that set/read
// req.session.
const bcrypt = require("bcryptjs");
const db = require("./db");

function requireAuth(req, res, next) {
  if (req.session && req.session.teacherId) return next();
  return res.status(401).json({ error: "not logged in" });
}

function verifyLogin(email, password) {
  if (!email || !password) return null;
  const teacher = db.prepare("SELECT * FROM teachers WHERE email = ?").get(email);
  if (!teacher) return null;
  if (!bcrypt.compareSync(password, teacher.password_hash)) return null;
  return teacher;
}

module.exports = { requireAuth, verifyLogin };
