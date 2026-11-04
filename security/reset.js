const crypto = require('crypto');
const { digest } = require('./sessions');
const mail = require('./email');
async function issueReset(client, user) {
  if (!user?.active) return;
  const token = crypto.randomBytes(32).toString('hex');
  await client.query('DELETE FROM password_reset_tokens WHERE user_id=$1', [user.id]);
  await client.query("INSERT INTO password_reset_tokens(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 minutes')", [digest(token), user.id]);
  await mail.sendReset(user.email, token);
}
module.exports = { issueReset };
