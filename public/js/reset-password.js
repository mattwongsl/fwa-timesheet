// Keep the token in memory only, clearing the fragment before any request.
const resetToken = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
document.getElementById('emailField').hidden = Boolean(resetToken);
document.getElementById('passwordField').hidden = !resetToken;
document.getElementById('submit').textContent = resetToken ? 'Set new password' : 'Send recovery instructions';
document.getElementById('recoveryForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.getElementById('submit'); button.disabled = true;
  const message = document.getElementById('message');
  try {
    const response = resetToken
      ? await Api.post('/api/auth/reset-password', { token: resetToken, newPassword: document.getElementById('newPassword').value })
      : await Api.post('/api/auth/forgot-password', { email: document.getElementById('email').value });
    message.textContent = resetToken ? 'Password updated. Please sign in again.' : response.message;
    if (resetToken) document.getElementById('recoveryForm').hidden = true;
  } catch (error) { message.textContent = error.message; }
  finally { button.disabled = false; }
});
