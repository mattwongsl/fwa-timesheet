require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');

const pool = require('./db/pool');
const authRoutes = require('./routes/auth');
const timesheetRoutes = require('./routes/timesheets');
const projectRoutes = require('./routes/projects');
const employeeRoutes = require('./routes/employees');
const adminRoutes = require('./routes/admin');

const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));

app.use('/api/auth', authRoutes);
app.use('/api/timesheets', timesheetRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/admin', adminRoutes);

app.use(express.static(path.join(__dirname, 'public')));

// Fallback: send index.html for any non-API route (simple client-side routing).
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Basic error handler so a thrown error doesn't crash the process.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong on the server.' });
});

async function ensureSchemaAndAdmin() {
  const fs = require('fs');
  const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);

  const existingAdmin = await pool.query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
  if (existingAdmin.rows.length === 0) {
    const name = process.env.INITIAL_ADMIN_NAME || 'Admin';
    const email = (process.env.INITIAL_ADMIN_EMAIL || 'admin@yourcompany.com').toLowerCase();
    const password = process.env.INITIAL_ADMIN_PASSWORD || 'ChangeMe123!';
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO NOTHING',
      [name, email, hash, 'admin']
    );
    console.log(`No admin found. Created initial admin account: ${email}`);
    console.log('IMPORTANT: log in and change this password immediately.');
  }
}

const PORT = process.env.PORT || 3000;

ensureSchemaAndAdmin()
  .then(() => {
    app.listen(PORT, () => console.log(`Timesheet app listening on port ${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
