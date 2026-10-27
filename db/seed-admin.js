require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./pool');

async function seedAdmin() {
  const name = process.env.INITIAL_ADMIN_NAME || 'Admin';
  const email = (process.env.INITIAL_ADMIN_EMAIL || 'admin@yourcompany.com').toLowerCase();
  const password = process.env.INITIAL_ADMIN_PASSWORD || 'ChangeMe123!';

  const hash = await bcrypt.hash(password, 10);

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    await pool.query(
      'UPDATE users SET password_hash = $1, role = $2, active = true WHERE email = $3',
      [hash, 'admin', email]
    );
    console.log(`Existing admin ${email} updated with new password.`);
  } else {
    await pool.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)',
      [name, email, hash, 'admin']
    );
    console.log(`Admin account created: ${email}`);
  }
  await pool.end();
}

seedAdmin().catch((err) => {
  console.error('Failed to seed admin:', err);
  process.exit(1);
});
