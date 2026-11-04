const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { cookieOptions } = require('./config');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const SESSION_SECONDS = 8 * 60 * 60;
async function createSession(database, user) {
  const sid = crypto.randomBytes(32).toString('hex');
  await database.query("INSERT INTO auth_sessions(id_hash,user_id,expires_at) VALUES($1,$2,now()+interval '8 hours')", [digest(sid), user.id]);
  return jwt.sign({ id: user.id, sid }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: SESSION_SECONDS });
}
function setSession(res, token) { res.cookie('token', token, { ...cookieOptions(), maxAge: SESSION_SECONDS * 1000 }); }
async function revokeAll(database, id) {
  await database.query('DELETE FROM auth_sessions WHERE user_id=$1', [id]);
  await database.query('DELETE FROM password_reset_tokens WHERE user_id=$1', [id]);
}
module.exports = { digest, createSession, setSession, revokeAll };
