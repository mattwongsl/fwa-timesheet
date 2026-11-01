function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
function object(value, allowedKeys, label = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, `${label} must be an object.`);
  for (const key of Object.keys(value)) if (!allowedKeys.includes(key)) throw httpError(400, `${label}.${key} is not supported.`);
  return value;
}
function positiveId(value, label = 'id') {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647) {
    throw httpError(400, `${label} must be a positive integer.`);
  }
  return Number(value);
}
function text(value, label, { required = false, max = 4000 } = {}) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw httpError(400, `${label} must be ${required ? 'a nonempty' : 'a'} string of at most ${max} characters.`);
  return value.trim();
}
function date(value, label = 'date') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw httpError(400, `${label} must be a valid YYYY-MM-DD date.`);
  return value;
}
function version(value) {
  if (!Number.isInteger(value) || value < 0 || value > 2147483646) throw httpError(400, 'version must be a nonnegative integer from the loaded timesheet.');
  return value;
}
function range(query) {
  const from = query.from === undefined ? '1970-01-01' : date(query.from, 'from');
  const to = query.to === undefined ? '2999-12-31' : date(query.to, 'to');
  if (from > to) throw httpError(400, 'from must be on or before to.');
  return { from, to };
}
module.exports = { httpError, object, positiveId, text, date, version, range };
