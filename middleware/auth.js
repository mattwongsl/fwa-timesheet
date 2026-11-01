const jwt = require('jsonwebtoken');
const pool = require('../db/pool');

async function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Not logged in.' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (!payload || !Number.isSafeInteger(payload.id) || payload.id <= 0 || payload.id > 2147483647) throw new Error('Invalid identity.');
  } catch (err) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }

  try {
    // Tokens identify a session; the current database account determines access.
    const result = await pool.query('SELECT id, name, email, role, active FROM users WHERE id = $1', [payload.id]);
    const user = result.rows[0];
    if (!user || !user.active) return res.status(401).json({ error: 'This account is inactive or no longer exists.' });
    req.user = { id: user.id, name: user.name, email: user.email, role: user.role };
    next();
  } catch (err) {
    next(err);
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
  next();
}

module.exports = { requireAuth, requireAdmin };
