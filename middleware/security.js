const crypto = require('crypto');
const { rateLimit } = require('express-rate-limit');
const { cookieOptions } = require('../security/config');
const { digest } = require('../security/sessions');
// A signed, host-only double-submit cookie; tokens remain valid across open tabs.
function csrfToken() { const nonce = crypto.randomBytes(32).toString('hex'); return nonce + '.' + crypto.createHmac('sha256', process.env.JWT_SECRET).update(nonce).digest('hex'); }
function validCsrf(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(token)) return false;
  const [nonce, signature] = token.split('.');
  return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), crypto.createHmac('sha256', process.env.JWT_SECRET).update(nonce).digest());
}
function trustedOrigins() { return [process.env.APP_ORIGIN, ...(process.env.TRUSTED_ORIGINS || '').split(',')].filter(Boolean); }
function originAllowed(req, origin) {
  if (trustedOrigins().includes(origin)) return true;
  // Same-origin development without explicit config; production requires APP_ORIGIN.
  return process.env.NODE_ENV !== 'production' && origin === `${req.protocol}://${req.get('host')}`;
}
function requestSecurity(req, res, next) {
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  if (process.env.NODE_ENV === 'production' && !req.secure) return res.status(400).json({ error: 'HTTPS is required.' });
  const origin = req.get('origin');
  if (origin && !originAllowed(req, origin)) return res.status(403).json({ error: 'Origin is not trusted.' });
  if (origin) { res.set('Access-Control-Allow-Origin', origin); res.set('Access-Control-Allow-Credentials', 'true'); res.vary('Origin'); }
  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token'); res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE'); return res.sendStatus(204);
  }
  if (req.path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const token = req.get('x-csrf-token');
    if (req.get('sec-fetch-site') === 'cross-site' || !validCsrf(token) || token !== req.cookies.csrf) return res.status(403).json({ error: 'Invalid CSRF token. Reload and try again.' });
    if (!req.is('application/json')) return res.status(415).json({ error: 'Use application/json.' });
  }
  next();
}
function csrfEndpoint(req, res) {
  const token = validCsrf(req.cookies.csrf) ? req.cookies.csrf : csrfToken();
  res.cookie('csrf', token, { ...cookieOptions(), maxAge: 8 * 60 * 60 * 1000 }); res.json({ csrfToken: token });
}
const limit = (max, windowMs = 15 * 60 * 1000, extra = {}) => rateLimit({ windowMs, limit: max, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many attempts. Please try again later.' }, ...extra });
// Per-account failed login limit complements a generous IP limit for shared offices.
const loginAccount = limit(10, 15 * 60 * 1000, { keyGenerator: req => digest(String(req.body?.email || '').trim().toLowerCase()), skipSuccessfulRequests: true });
module.exports = { requestSecurity, csrfEndpoint, validCsrf, loginAccount, loginIp: limit(150), resetIp: limit(30), sensitive: limit(60), limit };
