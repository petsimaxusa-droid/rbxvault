const express = require('express');
const fetch = require('node-fetch');
const session = require('express-session');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// =============================================
// CONFIG
// =============================================
const DISCORD_CLIENT_ID = '1485007931803045908';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = 'https://rbxvault.cc/auth/discord/callback';
const FRONTEND_URL = 'https://rbxvault.cc';
const TURNSTILE_SECRET = '0x4AAAAAACukg2cJBDI0l_mat01s4MxOcSg';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM = process.env.EMAIL_FROM || 'noreply@rbxvault.cc';
// =============================================

// PostgreSQL - Railway provides DATABASE_URL automatically
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Create users table if it doesn't exist
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE,
      username TEXT UNIQUE NOT NULL,
      password TEXT,
      discord_id TEXT UNIQUE,
      discord_avatar TEXT,
      balance NUMERIC DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('Database ready');
}
initDB().catch(console.error);

app.set('trust proxy', 1); // Railway sits behind a proxy
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'rbxvault-secret-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

// =============================================
// PAGE ROUTES
// =============================================
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// =============================================
// REGISTER — Step 1: validate + captcha + send email code
// =============================================
app.post('/api/register/send-code', async (req, res) => {
  const { email, username, password, turnstileToken } = req.body;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  if (!emailRegex.test(email)) return res.json({ ok: false, error: 'Please use a valid email.' });
  if (!username || username.length < 3) return res.json({ ok: false, error: 'Username must be at least 3 characters.' });
  if (username.length > 16) return res.json({ ok: false, error: 'Username cannot be longer than 16 characters.' });
  if (!password || password.length < 8) return res.json({ ok: false, error: 'Password must be at least 8 characters.' });
  if (!turnstileToken) return res.json({ ok: false, error: 'Captcha required.' });

  // Verify Turnstile
  try {
    const cfRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: turnstileToken })
    });
    const cfData = await cfRes.json();
    if (!cfData.success) return res.json({ ok: false, error: 'Captcha verification failed. Please try again.' });
  } catch (err) {
    console.error('Turnstile error:', err);
    return res.json({ ok: false, error: 'Captcha check failed. Please try again.' });
  }

  // Check if email/username already taken
  try {
    const emailCheck = await pool.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (emailCheck.rows.length > 0) return res.json({ ok: false, error: 'This email has already been registered.' });
    const userCheck = await pool.query('SELECT id FROM users WHERE username ILIKE $1', [username]);
    if (userCheck.rows.length > 0) return res.json({ ok: false, error: 'This username has already been taken.' });
  } catch (err) {
    console.error(err);
    return res.json({ ok: false, error: 'Something went wrong. Please try again.' });
  }

  // Generate 6-digit code and store in session
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  req.session.pendingReg = { email: email.toLowerCase(), username, password, code, expires: Date.now() + 10 * 60 * 1000 };

  // Send email via Resend
  try {
    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: email,
        subject: 'Your RbxVault verification code',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#090909;color:#f0f0f0;padding:40px;border-radius:12px">
            <h2 style="color:#1DDD7E;margin-bottom:8px">RbxVault</h2>
            <p style="color:#7a7a8a;margin-bottom:32px">Email Verification</p>
            <p>Your verification code is:</p>
            <div style="background:#16161e;border:1px solid rgba(29,221,126,0.25);border-radius:10px;padding:24px;text-align:center;margin:24px 0">
              <span style="font-size:40px;font-weight:800;letter-spacing:12px;color:#1DDD7E">${code}</span>
            </div>
            <p style="color:#7a7a8a;font-size:13px">This code expires in 10 minutes. If you didn't request this, ignore this email.</p>
          </div>
        `
      })
    });
    if (!emailRes.ok) {
      const errData = await emailRes.json();
      console.error('Resend error:', errData);
      return res.json({ ok: false, error: 'Failed to send verification email. Please try again.' });
    }
  } catch (err) {
    console.error('Email send error:', err);
    return res.json({ ok: false, error: 'Failed to send verification email. Please try again.' });
  }

  res.json({ ok: true });
});

// =============================================
// REGISTER — Step 2: verify code + create account
// =============================================
app.post('/api/register/verify', async (req, res) => {
  const { code } = req.body;
  const pending = req.session.pendingReg;

  if (!pending) return res.json({ ok: false, error: 'Session expired. Please start over.' });
  if (Date.now() > pending.expires) {
    delete req.session.pendingReg;
    return res.json({ ok: false, error: 'Code expired. Please start over.' });
  }
  if (code !== pending.code) return res.json({ ok: false, error: 'Incorrect code. Please try again.' });

  try {
    // Double-check email/username still free
    const emailCheck = await pool.query('SELECT id FROM users WHERE email=$1', [pending.email]);
    if (emailCheck.rows.length > 0) return res.json({ ok: false, error: 'This email has already been registered.' });

    const result = await pool.query(
      'INSERT INTO users (email, username, password) VALUES ($1, $2, $3) RETURNING id, username',
      [pending.email, pending.username, pending.password]
    );
    const user = result.rows[0];
    delete req.session.pendingReg;
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ ok: true, username: user.username });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
});

// =============================================
// REGISTER — Resend code
// =============================================
app.post('/api/register/resend-code', async (req, res) => {
  const pending = req.session.pendingReg;
  if (!pending) return res.json({ ok: false, error: 'Session expired. Please start over.' });

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  req.session.pendingReg.code = code;
  req.session.pendingReg.expires = Date.now() + 10 * 60 * 1000;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: pending.email,
        subject: 'Your RbxVault verification code',
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;background:#090909;color:#f0f0f0;padding:40px;border-radius:12px">
            <h2 style="color:#1DDD7E;margin-bottom:8px">RbxVault</h2>
            <p style="color:#7a7a8a;margin-bottom:32px">Email Verification</p>
            <p>Your new verification code is:</p>
            <div style="background:#16161e;border:1px solid rgba(29,221,126,0.25);border-radius:10px;padding:24px;text-align:center;margin:24px 0">
              <span style="font-size:40px;font-weight:800;letter-spacing:12px;color:#1DDD7E">${code}</span>
            </div>
            <p style="color:#7a7a8a;font-size:13px">This code expires in 10 minutes.</p>
          </div>
        `
      })
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, error: 'Failed to resend. Please try again.' });
  }
});

// =============================================
// LOGIN
// =============================================
app.post('/api/login', async (req, res) => {
  const { identifier, password } = req.body;
  if (!identifier || !password) return res.json({ ok: false, error: 'Please fill in all fields.' });

  try {
    const result = await pool.query(
      'SELECT id, username, password FROM users WHERE email=$1 OR username ILIKE $1',
      [identifier.toLowerCase()]
    );
    const user = result.rows[0];
    if (!user || user.password !== password) {
      return res.json({ ok: false, error: 'Email or password is incorrect.' });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ ok: true, username: user.username });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, error: 'Something went wrong. Please try again.' });
  }
});

// =============================================
// DISCORD OAUTH
// =============================================
app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify email',
    prompt: 'consent'
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect(FRONTEND_URL + '?error=no_code');

  try {
    console.log('[Discord] callback hit, code present:', !!code);
    console.log('[Discord] using client_id:', DISCORD_CLIENT_ID);
    console.log('[Discord] secret set:', !!DISCORD_CLIENT_SECRET);
    console.log('[Discord] redirect_uri:', REDIRECT_URI);

    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      })
    });
    const tokenData = await tokenRes.json();
    console.log('[Discord] token response:', JSON.stringify(tokenData));
    if (!tokenData.access_token) {
      console.error('[Discord] token exchange failed:', JSON.stringify(tokenData));
      const detail = encodeURIComponent(tokenData.error_description || tokenData.error || 'unknown');
      return res.redirect(FRONTEND_URL + '?error=token_failed&detail=' + detail);
    }

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const discordUser = await userRes.json();

    const freshAvatarUrl = discordUser.avatar
      ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png?size=64`
      : '';

    const discordEmail = (discordUser.email || '').toLowerCase() || null;

    // 1) Returning user — find by discord_id
    let user = (await pool.query(
      'SELECT id, username, discord_avatar FROM users WHERE discord_id=$1',
      [discordUser.id]
    )).rows[0];

    if (!user && discordEmail) {
      // 2) Email match — user registered manually before, link discord to their account
      const byEmail = (await pool.query(
        'SELECT id, username, discord_avatar FROM users WHERE email=$1',
        [discordEmail]
      )).rows[0];
      if (byEmail) {
        await pool.query(
          'UPDATE users SET discord_id=$1, discord_avatar=$2 WHERE id=$3',
          [discordUser.id, freshAvatarUrl, byEmail.id]
        );
        user = { ...byEmail, discord_avatar: freshAvatarUrl };
      }
    }

    if (!user) {
      // 3) New user — create account from Discord profile
      let username = (discordUser.global_name || discordUser.username)
        .slice(0, 16).replace(/[^a-zA-Z0-9_]/g, '_') || 'user';

      // Ensure username is unique
      const taken = (await pool.query('SELECT id FROM users WHERE username ILIKE $1', [username])).rows[0];
      if (taken) username = username.slice(0, 12) + '_' + Math.floor(Math.random() * 1000);

      const result = await pool.query(
        'INSERT INTO users (email, username, discord_id, discord_avatar) VALUES ($1, $2, $3, $4) RETURNING id, username, discord_avatar',
        [discordEmail, username, discordUser.id, freshAvatarUrl]
      );
      user = result.rows[0];
    } else {
      // Refresh avatar in case it changed
      await pool.query('UPDATE users SET discord_avatar=$1 WHERE id=$2', [freshAvatarUrl, user.id]);
      user.discord_avatar = freshAvatarUrl;
    }

    req.session.userId = user.id;
    req.session.username = user.username;

    const avatarUrl = user.discord_avatar || '';
    res.redirect(
      FRONTEND_URL +
      '?discord_login=success&username=' + encodeURIComponent(user.username) +
      '&avatar=' + encodeURIComponent(avatarUrl)
    );
  } catch (err) {
    console.error('Discord OAuth error:', err);
    const msg = encodeURIComponent(err.message || 'oauth_failed');
    res.redirect(FRONTEND_URL + '?error=oauth_failed&detail=' + msg);
  }
});

// =============================================
// SESSION CHECK
// =============================================
app.get('/api/me', async (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  try {
    const result = await pool.query(
      'SELECT username, discord_avatar, balance FROM users WHERE id=$1',
      [req.session.userId]
    );
    const user = result.rows[0];
    if (!user) return res.json({ loggedIn: false });
    res.json({ loggedIn: true, username: user.username, avatar: user.discord_avatar || null, balance: user.balance });
  } catch {
    res.json({ loggedIn: false });
  }
});

// =============================================
// LOGOUT
// =============================================
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`RbxVault running on port ${PORT}`));
