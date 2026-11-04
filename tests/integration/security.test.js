const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const database = new URL(process.env.TEST_DATABASE_URL || 'postgresql://invalid/invalid');
if (process.env.FWA_ISOLATED_TEST !== '1' || process.env.DATABASE_URL !== process.env.TEST_DATABASE_URL || database.hostname !== '127.0.0.1' || database.pathname !== '/fwa_phase2_test' || !process.env.FWA_TEST_CLUSTER_TOKEN || !process.env.FWA_TEST_CLUSTER_DIR) throw Error('Use the isolated PostgreSQL runner.');
const pool = require('../../db/pool');
const { migrate } = require('../../db/migrationRunner');
const { digest } = require('../../security/sessions');
const mail = require('../../security/email');
let delivered = [];
mail.configured = () => true;
mail.sendReset = async (email, token) => { delivered.push({ email, token }); };
let server, origin, employee, admin;
const initial = 'Synthetic-long-password-123!';
const initialHash = bcrypt.hashSync(initial, 12);
async function client() {
  const jar = {};
  async function request(method, path, body, extra = {}) {
    const headers = { 'Content-Type': 'application/json', ...extra.headers };
    if (jar.csrf) headers['X-CSRF-Token'] = jar.csrf;
    headers.Cookie = Object.entries(jar).map(([k,v]) => `${k}=${v}`).join('; ');
    if (extra.csrf === false) delete headers['X-CSRF-Token'];
    if (extra.cookie) headers.Cookie = extra.cookie;
    const r = await fetch(origin + path, { method, headers, body: ['GET','HEAD'].includes(method) ? undefined : (extra.raw ?? JSON.stringify(body ?? {})), signal: AbortSignal.timeout(10000) });
    for (const cookie of r.headers.getSetCookie()) { const [pair] = cookie.split(';'); const index = pair.indexOf('='); jar[pair.slice(0,index)] = pair.slice(index+1); }
    const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json, headers: r.headers };
  }
  await request('GET','/api/auth/csrf');
  return { jar, request, login: (email='employee@example.test', password=initial) => request('POST','/api/auth/login',{email,password}) };
}
function status(r,n) { assert.equal(r.status,n,JSON.stringify(r.body)); return r.body; }
test.before(async()=>{
  assert.equal(await fs.realpath((await pool.query('SHOW data_directory')).rows[0].data_directory), await fs.realpath(process.env.FWA_TEST_CLUSTER_DIR));
  assert.equal((await pool.query('SELECT token FROM fwa_test_cluster_guard')).rows[0].token, process.env.FWA_TEST_CLUSTER_TOKEN);
  await migrate(pool);
  server = require('../../app').listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r)); origin='http://127.0.0.1:'+server.address().port;
});
test.beforeEach(async()=>{
  await pool.query('TRUNCATE auth_sessions,password_reset_tokens,timesheet_entries,unlock_requests,timesheets,projects,users RESTART IDENTITY');
  const rows=(await pool.query("INSERT INTO users(name,email,password_hash,role) VALUES('Employee','employee@example.test',$1,'employee'),('Admin','admin@example.test',$1,'admin') RETURNING *",[initialHash])).rows;
  [employee,admin]=rows;delivered=[];
});
test.after(async()=>{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await pool.end();});
test('valid login stores a hashed session ID and returns no credentials',async()=>{
  const c=await client();const r=await c.login();status(r,200);
  assert.deepEqual(Object.keys(r.body.user).sort(),['email','id','name','role']);
  const payload=jwt.verify(c.jar.token,process.env.JWT_SECRET,{algorithms:['HS256']});
  assert.equal(payload.exp-payload.iat,28800);assert.equal(payload.email,undefined);
  const session=(await pool.query('SELECT * FROM auth_sessions')).rows[0];assert.equal(session.id_hash,digest(payload.sid));assert.notEqual(session.id_hash,payload.sid);
  assert.match(r.headers.get('set-cookie'),/HttpOnly/i);assert.match(r.headers.get('set-cookie'),/SameSite=Lax/i);assert.match(r.headers.get('set-cookie'),/Path=\//);
  status(await c.request('GET','/api/auth/me'),200);
});
test('wrong password, unknown email and inactive users have identical errors',async()=>{
  const c=await client();const wrong=await c.login('employee@example.test','Wrong-password-123');const unknown=await c.login('nobody@example.test');
  await pool.query('UPDATE users SET active=false WHERE id=$1',[employee.id]);const inactive=await c.login();
  for(const r of [wrong,unknown,inactive])status(r,401);assert.deepEqual(wrong.body,unknown.body);assert.deepEqual(wrong.body,inactive.body);
});
test('missing, tampered, expired and legacy JWTs are rejected',async()=>{
  const c=await client();status(await c.request('GET','/api/auth/me'),401);await c.login();const valid=c.jar.token;
  for(const token of [valid.slice(0,-8)+'tampered',jwt.sign({id:employee.id,sid:'a'.repeat(64)},process.env.JWT_SECRET,{expiresIn:-1}),jwt.sign({id:employee.id},process.env.JWT_SECRET,{expiresIn:'1h'})])status(await c.request('GET','/api/auth/me',undefined,{cookie:'token='+token}),401);
});
test('logout revokes a copied cookie while another session remains valid',async()=>{
  const a=await client(),b=await client();await a.login();await b.login();const stolen=a.jar.token;status(await a.request('POST','/api/auth/logout'),200);
  status(await a.request('GET','/api/auth/me',undefined,{cookie:'token='+stolen}),401);status(await b.request('GET','/api/auth/me'),200);
});
test('deactivation permanently revokes access, even after reactivation',async()=>{
  const c=await client();await c.login();await pool.query('UPDATE users SET active=false WHERE id=$1',[employee.id]);status(await c.request('GET','/api/auth/me'),401);
  await pool.query('UPDATE users SET active=true WHERE id=$1',[employee.id]);status(await c.request('GET','/api/auth/me'),401);
});
test('removing administrator role takes effect on the next request',async()=>{
  const c=await client();await c.login('admin@example.test');status(await c.request('GET','/api/employees'),200);await pool.query("UPDATE users SET role='employee' WHERE id=$1",[admin.id]);status(await c.request('GET','/api/employees'),403);
});
test('password change enforces strength and bcrypt bounds and revokes all sessions',async()=>{
  const a=await client(),b=await client();await a.login();await b.login();
  for(const newPassword of ['short','é'.repeat(40)])status(await a.request('POST','/api/employees/me/password',{currentPassword:initial,newPassword}),400);
  status(await a.request('POST','/api/employees/me/password',{currentPassword:'wrong',newPassword:'A-new-private-passphrase-123'}),401);
  status(await a.request('POST','/api/employees/me/password',{currentPassword:initial,newPassword:'A-new-private-passphrase-123'}),200);
  status(await b.request('GET','/api/auth/me'),401);
  const hash=(await pool.query('SELECT password_hash FROM users WHERE id=$1',[employee.id])).rows[0].password_hash;
  assert.equal(bcrypt.getRounds(hash),12);assert.ok(await bcrypt.compare('A-new-private-passphrase-123',hash));assert.notEqual(hash,'A-new-private-passphrase-123');
});
test('employees cannot access administrator endpoints, foreign sheets or inject ownership',async()=>{
  const c=await client();await c.login();status(await c.request('GET','/api/employees'),403);status(await c.request('POST','/api/projects',{name:'Forbidden'}),403);
  const week=require('../../utils').currentWeekStart();const sheet=(await pool.query('INSERT INTO timesheets(user_id,week_start) VALUES($1,$2) RETURNING *',[admin.id,week])).rows[0];
  status(await c.request('PUT',`/api/timesheets/${sheet.id}/entries`,{version:0,days:[]}),403);
  status(await c.request('GET','/api/timesheets/mine?user_id='+admin.id),400);
  status(await c.request('PUT','/api/timesheets/not-an-id/entries',{version:0,days:[]}),400);
});
test('CSRF rejects forged writes including login/logout and trusted origins use exact matches',async()=>{
  const c=await client();status(await c.request('POST','/api/auth/login',{email:employee.email,password:initial},{csrf:false}),403);
  status(await c.request('POST','/api/auth/login',{email:employee.email,password:initial},{headers:{Origin:'https://evil.example'}}),403);
  status(await c.request('GET','/api/auth/csrf',undefined,{headers:{Origin:'https://evil.example'}}),403);
  const ok=await c.request('POST','/api/auth/login',{email:employee.email,password:initial},{headers:{Origin:origin}});status(ok,200);assert.equal(ok.headers.get('access-control-allow-origin'),origin);
  status(await c.request('POST','/api/auth/logout',{}, {csrf:false}),403);
  status(await c.request('POST','/api/auth/logout',{}, {headers:{'Sec-Fetch-Site':'cross-site'}}),403);
});
test('JSON limits, strict payloads, cache policy and security headers are enforced',async()=>{
  const c=await client();status(await c.request('POST','/api/auth/login',{}, {raw:'{"broken":'}),400);
  const large=await c.request('POST','/api/auth/login',{password:'x'.repeat(70000)});status(large,413);assert.doesNotMatch(JSON.stringify(large.body),/stack|SELECT|postgresql:/);
  status(await c.request('POST','/api/auth/login',{email:employee.email,password:initial,role:'admin'}),400);
  const r=await c.request('GET','/');status(r,200);assert.match(r.headers.get('content-security-policy'),/script-src 'self'/);assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.equal(r.headers.get('x-frame-options'),'SAMEORIGIN');
  assert.equal((await c.request('GET','/api/auth/me')).headers.get('cache-control'),'no-store');
});
test('recovery tokens are hashed, expiring, single-use and revoke previous sessions',async()=>{
  const c=await client();await c.login();status(await c.request('POST','/api/auth/forgot-password',{email:employee.email}),200);assert.equal(delivered.length,1);
  const token=delivered[0].token;const stored=(await pool.query('SELECT * FROM password_reset_tokens')).rows[0];assert.equal(stored.token_hash,digest(token));assert.notEqual(stored.token_hash,token);assert.ok(new Date(stored.expires_at)-new Date(stored.created_at)<=1800001);
  const recovery=await client();status(await recovery.request('POST','/api/auth/reset-password',{token,newPassword:'Replacement-private-passphrase-123'}),200);
  status(await c.request('GET','/api/auth/me'),401);status(await recovery.request('POST','/api/auth/reset-password',{token,newPassword:'Replacement-private-passphrase-456'}),400);assert.equal((await pool.query('SELECT count(*)::int AS n FROM password_reset_tokens')).rows[0].n,0);
});
test('recovery does not enumerate, rate-cools accounts, rejects expired tokens and preserves password until use',async()=>{
  const c=await client();const known=await c.request('POST','/api/auth/forgot-password',{email:employee.email});const unknown=await c.request('POST','/api/auth/forgot-password',{email:'unknown@example.test'});assert.deepEqual(known.body,unknown.body);
  await c.request('POST','/api/auth/forgot-password',{email:employee.email});assert.equal(delivered.length,1);
  assert.equal((await pool.query('SELECT password_hash FROM users WHERE id=$1',[employee.id])).rows[0].password_hash,initialHash);
  await pool.query("UPDATE password_reset_tokens SET expires_at=now()-interval '1 minute'");status(await c.request('POST','/api/auth/reset-password',{token:delivered[0].token,newPassword:'Replacement-private-passphrase-123'}),400);
});
test('administrator reset never returns passwords or resets them before token redemption',async()=>{
  const c=await client();await c.login('admin@example.test');const r=await c.request('POST',`/api/employees/${employee.id}/reset-password`);status(r,200);assert.equal(r.body.temporaryPassword,undefined);assert.equal(delivered.length,1);
  assert.equal((await pool.query('SELECT password_hash FROM users WHERE id=$1',[employee.id])).rows[0].password_hash,initialHash);
  const list=await c.request('GET','/api/employees');status(list,200);assert.doesNotMatch(JSON.stringify(list.body),/password_hash|\$2[aby]\$/);
  const created=await c.request('POST','/api/employees',{name:'New Employee',email:'new@example.test'});status(created,201);assert.equal(created.body.temporaryPassword,undefined);assert.equal(delivered.length,2);
});
test('missing email configuration is explicit and does not claim delivery',async()=>{
  const saved=mail.configured;mail.configured=()=>false;
  try{const c=await client();status(await c.request('POST','/api/auth/forgot-password',{email:employee.email}),503);assert.equal(delivered.length,0);}finally{mail.configured=saved;}
});
test('login rate limit rejects repeated failed attempts per normalized account',async()=>{
  const c=await client();let limited=false;
  for(let i=0;i<12;i++){const r=await c.login('rate-limit@example.test','Wrong-password-123');if(r.status===429){limited=true;break;}status(r,401);}assert.equal(limited,true);
});
test('production rejects weak configuration and issues secure cookies',async()=>{
  const {validateConfig,cookieOptions}=require('../../security/config');
  const env={DATABASE_URL:'postgresql://localhost/synthetic',JWT_SECRET:crypto.randomBytes(48).toString('hex'),NODE_ENV:'production',DEPLOYMENT_ENV:'production',APP_ORIGIN:'https://timesheet.example.test'};
  assert.doesNotThrow(()=>validateConfig(env));for(const value of ['', 'short', 'change-this-to-a-long-random-string'])assert.throws(()=>validateConfig({...env,JWT_SECRET:value}));
  assert.throws(()=>validateConfig({...env,APP_ORIGIN:'http://timesheet.example.test'}));assert.throws(()=>validateConfig({...env,TRUST_PROXY:'true'}));
  const previous=process.env.NODE_ENV;process.env.NODE_ENV='production';try{assert.equal(cookieOptions().secure,true);const c=await client();status(await c.request('GET','/api/auth/csrf'),400);}finally{process.env.NODE_ENV=previous;}
});

test('Chromium login, employee editor, administrator rendering and reset flow work under CSP', { skip: !process.env.FWA_PLAYWRIGHT_PATH }, async()=>{
  const { chromium } = require(process.env.FWA_PLAYWRIGHT_PATH);
  const browser = await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{window.cspViolations=[];document.addEventListener('securitypolicyviolation',e=>window.cspViolations.push(e.violatedDirective));});
    const bad='<img src=x onerror="window.securityXss=true">';
    await pool.query('UPDATE users SET name=$1 WHERE id=$2',[bad,employee.id]);
    await pool.query('INSERT INTO projects(name) VALUES($1)',[bad]);
    await page.goto(origin+'/');await page.fill('#email','employee@example.test');await page.fill('#password',initial);await page.click('#loginBtn');await page.waitForURL('**/employee.html');
    await page.waitForFunction(()=>document.querySelectorAll('.day-card').length===5);
    assert.equal(await page.evaluate(()=>window.securityXss),undefined);
    const write=await page.evaluate(()=>Api.post('/api/employees/me/password',{currentPassword:'wrong',newPassword:'A-new-private-passphrase-123'}).then(()=>200,e=>e.status));assert.equal(write,401);
    await page.click('#logoutLink');await page.waitForURL('**/index.html');
    await page.fill('#email','admin@example.test');await page.fill('#password',initial);await page.click('#loginBtn');await page.waitForURL('**/admin.html');
    await page.waitForFunction(()=>document.querySelector('#employeesBody').textContent.includes('<img'));
    await page.click('[data-tab="employees"]');assert.equal(await page.locator('#employeesBody img').count(),0);assert.equal(await page.locator('#projectsBody img').count(),0);assert.equal(await page.evaluate(()=>window.securityXss),undefined);
    assert.deepEqual(await page.evaluate(()=>window.cspViolations),[]);
    await page.goto(origin+'/reset-password.html');await page.fill('#email','employee@example.test');await page.click('#submit');await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('If an active account'));
    assert.equal(delivered.length,1);const token=delivered[0].token;
    await page.goto('about:blank');
    await page.goto(origin+'/reset-password.html#'+token);assert.equal(new URL(page.url()).hash,'');await page.fill('#newPassword','Browser-private-passphrase-123');await page.click('#submit');await page.waitForFunction(()=>document.querySelector('#message').textContent.includes('Password updated'));
    assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.cspViolations),[]);
  } finally {await browser.close();}
});

test('existing bcrypt hashes upgrade after successful login without changing the password',async()=>{
  await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2',[await bcrypt.hash(initial,10),employee.id]);
  const c=await client();status(await c.login(),200);
  assert.equal(bcrypt.getRounds((await pool.query('SELECT password_hash FROM users WHERE id=$1',[employee.id])).rows[0].password_hash),12);
});
test('database session expiry is enforced even if the JWT has not expired',async()=>{
  const c=await client();await c.login();await pool.query("UPDATE auth_sessions SET expires_at=now()-interval '1 second'");status(await c.request('GET','/api/auth/me'),401);
});
test('recovery endpoint throttles repeated requests',async()=>{
  const c=await client();let limited=false;
  for(let i=0;i<31;i++){const r=await c.request('POST','/api/auth/forgot-password',{email:'rate-recovery@example.test'});if(r.status===429){limited=true;break;}status(r,200);}assert.equal(limited,true);
});

test('initial administrator provisioning refuses defaults and never resets an existing account',async()=>{
  const {spawn}=require('node:child_process');
  const run=(password)=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['db/seed-admin.js'],{env:{...process.env,INITIAL_ADMIN_NAME:'Synthetic Provisioned',INITIAL_ADMIN_EMAIL:'provisioned@example.test',INITIAL_ADMIN_PASSWORD:password},stdio:'ignore'});
    child.on('error',reject);child.on('exit',resolve);
  });
  assert.equal(await run('ChangeMe123!'),1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM users WHERE email='provisioned@example.test'")).rows[0].n,0);
  assert.equal(await run('Provisioned-private-passphrase-123'),0);
  const before=(await pool.query("SELECT password_hash FROM users WHERE email='provisioned@example.test'")).rows[0].password_hash;
  assert.equal(bcrypt.getRounds(before),12);assert.ok(await bcrypt.compare('Provisioned-private-passphrase-123',before));
  assert.equal(await run('Another-private-passphrase-456'),1);
  assert.equal((await pool.query("SELECT password_hash FROM users WHERE email='provisioned@example.test'")).rows[0].password_hash,before);
});
test('production HTTPS/proxy path sets Secure cookie on the wire and rejects spoofing when proxy is disabled',async()=>{
  const app=require('../../app');const previous=process.env.NODE_ENV;process.env.NODE_ENV='production';app.set('trust proxy',1);
  try{
    const r=await fetch(origin+'/api/auth/csrf',{headers:{'X-Forwarded-Proto':'https'}});assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/; Secure/);
    app.set('trust proxy',false);const denied=await fetch(origin+'/api/auth/csrf',{headers:{'X-Forwarded-Proto':'https'}});assert.equal(denied.status,400);
  }finally{process.env.NODE_ENV=previous;app.set('trust proxy',false);}
});

test('server startup validates configuration and serves the migrated synthetic database',async()=>{
  const previousPort=process.env.PORT;process.env.PORT='0';
  let instance;
  try{
    instance=await require('../../server').start();
    if(!instance.listening)await new Promise(r=>instance.once('listening',r));
    const r=await fetch('http://127.0.0.1:'+instance.address().port+'/api/auth/csrf');assert.equal(r.status,200);
  }finally{if(instance){instance.closeAllConnections();await new Promise(r=>instance.close(r));}if(previousPort===undefined)delete process.env.PORT;else process.env.PORT=previousPort;}
});
