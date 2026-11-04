const { randomBytes } = require('crypto');
function validateConfig(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  let db; try { db = new URL(env.DATABASE_URL); } catch { throw new Error('DATABASE_URL must be a valid PostgreSQL URL.'); }
  if (!['postgres:', 'postgresql:'].includes(db.protocol)) throw new Error('DATABASE_URL must use PostgreSQL.');
  const secret = env.JWT_SECRET || '';
  if (Buffer.byteLength(secret) < 32 || /change.?this|placeholder|example|^test|secret.{0,3}here/i.test(secret)) throw new Error('JWT_SECRET must be a private random value of at least 32 bytes.');
  if (env.NODE_ENV === 'production') {
    if (!env.APP_ORIGIN || new URL(env.APP_ORIGIN).protocol !== 'https:') throw new Error('Production requires HTTPS APP_ORIGIN.');
    if (!env.DEPLOYMENT_ENV || env.DEPLOYMENT_ENV !== 'production') throw new Error('Production requires DEPLOYMENT_ENV=production. Use separate database credentials and JWT secrets for development.');
  }
  for (const value of [env.APP_ORIGIN, ...(env.TRUSTED_ORIGINS || '').split(',')].filter(Boolean)) {
    let url; try { url = new URL(value); } catch { throw new Error('Origins must be valid URLs.'); }
    if (url.origin !== value || !['http:', 'https:'].includes(url.protocol) || (env.NODE_ENV === 'production' && url.protocol !== 'https:')) throw new Error('Trusted origins must be exact origins, HTTPS in production.');
  }
  if (env.TRUST_PROXY && !['0', '1'].includes(env.TRUST_PROXY)) throw new Error('TRUST_PROXY must be 0 or 1. Only enable 1 behind a single trusted proxy with no direct access.');
}
function password(value) {
  if (typeof value !== 'string' || value.length < 12 || Buffer.byteLength(value, 'utf8') > 72 || /^(changeme|password|123456|qwerty)/i.test(value)) {
    const err = new Error('Use a password of at least 12 characters and at most 72 UTF-8 bytes; avoid common placeholder passwords.'); err.status = 400; throw err;
  }
  return value;
}
const cookieOptions = () => ({ httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });
module.exports = { validateConfig, password, cookieOptions, randomBytes };
