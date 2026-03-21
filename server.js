const express = require('express');
const fetch = require('node-fetch');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// =============================================
// CONFIG - fill these in
// =============================================
const DISCORD_CLIENT_ID = 'YOUR_CLIENT_ID';
const DISCORD_CLIENT_SECRET = 'YOUR_CLIENT_SECRET';
const REDIRECT_URI = 'https://YOUR_DOMAIN/auth/discord/callback';
const FRONTEND_URL = 'https://YOUR_DOMAIN';
// =============================================

const USERS_FILE = path.join(__dirname, 'users.json');

function getUsers() {
  if (!fs.existsSync(USERS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch { return []; }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'rbxvault-secret-change-this',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// Serve frontend
app.use(express.static(path.join(__dirname, 'public')));

// =============================================
// EMAIL/PASSWORD REGISTER
// =============================================
app.post('/api/register', (req, res) => {
  const { email, username, password } = req.body;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  if (!emailRegex.test(email)) return res.json({ ok: false, error: 'Please use a valid email.' });
  if (username.length < 3) return res.json({ ok: false, error: 'Username must be at least 3 characters.' });
  if (username.length > 16) return res.json({ ok: false, error: 'Username cannot be longer than 16 characters.' });
  if (password.length < 8) return res.json({ ok: false, error: 'Password must be at least 8 characters.' });

  const users = getUsers();
  if (users.find(u => u.email === email.toLowerCase())) return res.json({ ok: false, error: 'This email has already been registered.' });
  if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) return res.json({ ok: false, error: 'This username has already been registered.' });

  const user = { id: Date.now().toString(), email: email.toLowerCase(), username, password, discord: null, createdAt: new Date().toISOString() };
  users.push(user);
  saveUsers(users);

  req.session.userId = user.id;
  res.json({ ok: true, username: user.username });
});

// =============================================
// EMAIL/PASSWORD LOGIN
// =============================================
app.post('/api/login', (req, res) => {
  const { identifier, password } = req.body;
  const users = getUsers();
  const user = users.find(u =>
    u.email === identifier.toLowerCase() ||
    u.username.toLowerCase() === identifier.toLowerCase()
  );
  if (!user || user.password !== password) return res.json({ ok: false, error: 'Email or password is incorrect.' });
  req.session.userId = user.id;
  res.json({ ok: true, username: user.username });
});

// =============================================
// DISCORD OAUTH - Step 1: redirect to Discord
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

// =============================================
// DISCORD OAUTH - Step 2: handle callback
// =============================================
app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect(FRONTEND_URL + '?error=no_code');

  try {
    // Exchange code for token
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

    // Fetch Discord user profile
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const discordUser = await userRes.json();

    const users = getUsers();
    let user = users.find(u => u.discord === discordUser.id);

    if (!user) {
      // Register new user via Discord
      let username = discordUser.username;
      // Make username unique if taken
      if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
        username = username + '_' + discordUser.discriminator;
      }
      user = {
        id: Date.now().toString(),
        email: (discordUser.email || '').toLowerCase(),
        username,
        password: null,
        discord: discordUser.id,
        discordAvatar: discordUser.avatar,
        createdAt: new Date().toISOString()
      };
      users.push(user);
      saveUsers(users);
    }

    req.session.userId = user.id;
    res.redirect(FRONTEND_URL + '?discord_login=success&username=' + encodeURIComponent(user.username));

  } catch (err) {
    console.error('Discord OAuth error:', err);
    res.redirect(FRONTEND_URL + '?error=oauth_failed');
  }
});

// =============================================
// SESSION CHECK
// =============================================
app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ loggedIn: false });
  const users = getUsers();
  const user = users.find(u => u.id === req.session.userId);
  if (!user) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, username: user.username, discord: !!user.discord });
});

// =============================================
// LOGOUT
// =============================================
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`RbxVault backend running on port ${PORT}`));
