
    async function doLogin() {
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;
      const errEl = document.getElementById('err');
      errEl.textContent = '';
      if (!email || !password) {
        errEl.textContent = 'Please enter your email and password.';
        return;
      }
      try {
        const { user } = await Api.post('/api/auth/login', { email, password });
        window.location.href = user.role === 'admin' ? '/admin.html' : '/employee.html';
      } catch (e) {
        errEl.textContent = e.message;
      }
    }

    document.getElementById('loginBtn').addEventListener('click', doLogin);
    document.getElementById('password').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doLogin();
    });

    // If already logged in, skip straight to the right dashboard.
    (async () => {
      try {
        const { user } = await Api.get('/api/auth/me');
        window.location.href = user.role === 'admin' ? '/admin.html' : '/employee.html';
      } catch (e) { /* not logged in, stay here */ }
    })();
