const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const { requestSecurity, csrfEndpoint } = require('./middleware/security');
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
app.use(helmet({ contentSecurityPolicy: { directives: {
  defaultSrc: ["'self'"], scriptSrc: ["'self'"], scriptSrcAttr: ["'none'"],
  styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'],
  connectSrc: ["'self'", ...[process.env.APP_ORIGIN, ...(process.env.TRUSTED_ORIGINS || '').split(',')].filter(Boolean)],
  objectSrc: ["'none'"], frameAncestors: ["'none'"], formAction: ["'self'"],
  upgradeInsecureRequests: process.env.NODE_ENV === 'production' ? [] : null
} }, strictTransportSecurity: process.env.NODE_ENV === 'production' ? undefined : false }));
app.use(express.json({ limit: '64kb', strict: true }));
app.use(cookieParser());
app.use(requestSecurity);
app.get('/api/auth/csrf', csrfEndpoint);
app.use('/api/auth', require('./routes/auth'));
app.use('/api/timesheets', require('./routes/timesheets'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/employees', require('./routes/employees'));
app.use('/api/admin', require('./routes/admin'));
app.use(express.static(path.join(__dirname, 'public')));
app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const databaseStatuses = { '23505': 409, '23503': 409, '23514': 400, '23502': 400, '22P02': 400, '22007': 400, '22008': 400, '40001': 409, '40P01': 409 };
  const status = err.status || databaseStatuses[err.code] || 500;
  let message = err.status && status < 500 ? err.message : 'Something went wrong on the server.';
  if (status === 503) message = 'Password recovery email is unavailable. Contact your administrator.';
  if (err.type === 'entity.too.large') message = 'Request body is too large.';
  if (err.type === 'entity.parse.failed') message = 'Invalid JSON request body.';
  else if (!err.status && status === 400) message = 'The supplied data violates a database integrity rule. Check the dates, hours, and entry types.';
  else if (!err.status && status === 409) message = 'This change conflicts with another operation or referenced historical records. Reload and try again.';
  // Do not log request bodies, credentials, tokens, or raw SQL errors.
  if (status >= 500) console.error('Request failed:', err.code || err.name || 'Error');
  res.status(status).json({ error: message });
});
module.exports = app;
