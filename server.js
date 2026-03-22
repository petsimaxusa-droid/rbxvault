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
const DISCORD_CLIENT_SECRET = 'hri2hMiUPhUI_xjxFkr6qCdQKuMRyg8D';
const REDIRECT_URI = 'https://rbxvault.cc/auth/discord/callback';
const FRONTEND_URL = 'https://rbxvault.cc';
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

app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'rbxvault-secret-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

// =============================================
// REGISTER
// =============================================
app.post('/api/register', async (req, res) => {
  const { email, username, password } = req.body;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  if (!emailRegex.test(email)) return res.json({ ok: false, error: 'Please use a valid email.' });
  if (!username || username.length < 3) return res.json({ ok: false, error: 'Username must be at least 3 characters.' });
  if (username.length > 16) return res.json({ ok: false, error: 'Username cannot be longer than 16 characters.' });
  if (!password || password.length < 8) return res.json({ ok: false, error: 'Password must be at least 8 characters.' });

  try {
    const existing = await pool.query(
      'SELECT id FROM users WHERE email=$1 OR username ILIKE $2',
      [email.toLowerCase(), username]
    );
    if (existing.rows.length > 0) {
      const taken = existing.rows[0];
      // Check which one is taken
      const emailCheck = await pool.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
      if (emailCheck.rows.length > 0) return res.json({ ok: false, error: 'This email has already been registered.' });
      return res.json({ ok: false, error: 'This username has already been registered.' });
    }

    const result = await pool.query(
      'INSERT INTO users (email, username, password) VALUES ($1, $2, $3) RETURNING id, username',
      [email.toLowerCase(), username, password]
    );
    const user = result.rows[0];
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ ok: true, username: user.username });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, error: 'Something went wrong. Please try again.' });
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
    prompt: 'none'
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect(FRONTEND_URL + '?error=no_code');

  try {
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
    if (!tokenData.access_token) return res.redirect(FRONTEND_URL + '?error=token_failed');

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const discordUser = await userRes.json();

    // Find or create user
    let user = (await pool.query('SELECT id, username, discord_avatar FROM users WHERE discord_id=$1', [discordUser.id])).rows[0];

    if (!user) {
      let username = discordUser.username.slice(0, 16).replace(/[^a-zA-Z0-9_]/g, '_');
      // Make unique if taken
      const taken = (await pool.query('SELECT id FROM users WHERE username ILIKE $1', [username])).rows[0];
      if (taken) username = username.slice(0, 13) + '_' + Math.floor(Math.random()*100);

      const avatarUrl = discordUser.avatar
        ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png?size=64`
        : '';

      const result = await pool.query(
        'INSERT INTO users (email, username, discord_id, discord_avatar) VALUES ($1, $2, $3, $4) RETURNING id, username, discord_avatar',
        [(discordUser.email || '').toLowerCase() || null, username, discordUser.id, avatarUrl]
      );
      user = result.rows[0];
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
    res.redirect(FRONTEND_URL + '?error=oauth_failed');
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
