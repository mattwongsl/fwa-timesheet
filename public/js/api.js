const Api = {
  async request(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  },
  get(url) { return this.request('GET', url); },
  post(url, body) { return this.request('POST', url, body); },
  put(url, body) { return this.request('PUT', url, body); },
  patch(url, body) { return this.request('PATCH', url, body); },
  delete(url) { return this.request('DELETE', url); }
};

// Redirects to login if the session is invalid/expired. Returns the user object.
async function requireSession() {
  try {
    const { user } = await Api.get('/api/auth/me');
    return user;
  } catch (e) {
    window.location.href = '/index.html';
    return null;
  }
}

async function logout() {
  await Api.post('/api/auth/logout');
  window.location.href = '/index.html';
}

function fmtHours(n) {
  const num = Number(n) || 0;
  return (Math.round(num * 100) / 100).toString();
}
