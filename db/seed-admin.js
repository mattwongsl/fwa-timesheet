if (process.env.NODE_ENV !== 'test') require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./pool');
const { password } = require('../security/config');
async function seedAdmin() {
  const name = process.env.INITIAL_ADMIN_NAME;
  const email = (process.env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase();
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /@yourcompany\.com$/.test(email)) throw Error('Explicit administrator name and valid private email are required.');
  const chosen = password(process.env.INITIAL_ADMIN_PASSWORD);
  const hash = await bcrypt.hash(chosen, 12);
  const result = await pool.query("INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,'admin') ON CONFLICT(email) DO NOTHING RETURNING id", [name, email, hash]);
  if (!result.rowCount) throw Error('Account already exists. Seed refuses to reset passwords, change roles, or reactivate accounts. Use authorized account recovery.');
  console.log('Initial administrator created.');
}
seedAdmin().catch(() => { console.error('Administrator seed failed. Check explicit credentials, database readiness, and whether the account already exists.'); process.exitCode = 1; }).finally(() => pool.end());
