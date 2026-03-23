// Toast notification
function toast(msg, type='error') {
  let c = document.getElementById('_toastContainer');
  if(!c){ c = document.createElement('div'); c.id='_toastContainer'; c.style.cssText='position:fixed;top:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none'; document.body.appendChild(c); }
  const t = document.createElement('div');
  t.style.cssText = 'background:#1a1a1a;border:0.5px solid rgba(255,255,255,0.12);border-left:3px solid '+(type==='success'?'#1DDD7E':'#e74c3c')+';border-radius:10px;padding:12px 16px;font-size:13px;color:#fff;opacity:0;transform:translateY(-8px);transition:all .3s;max-width:320px;pointer-events:none';
  t.textContent = msg;
  c.appendChild(t);
  requestAnimationFrame(()=>requestAnimationFrame(()=>{ t.style.opacity='1'; t.style.transform='translateY(0)'; }));
  setTimeout(()=>{ t.style.opacity='0'; setTimeout(()=>t.remove(),400); }, 3500);
}

function goToOverview() {
  const mode = localStorage.getItem('rbxvault_mode') || 'customer';
  showPage(mode === 'vendor' ? 'vendor_overview' : 'customer_overview');
}

const _s = JSON.parse(localStorage.getItem('rbxvault_session') || 'null');
if(!_s) window.location.href = '/';
const BACKEND = 'https://rbxvault.cc';

const VENDOR_PAGES   = ['vendor_overview', 'vendor_market', 'vendor_accounts', 'vendor_proxies', 'vendor_sales', 'vendor_withdraw', 'vendor_tx'];
const CUSTOMER_PAGES = ['customer_overview', 'customer_market', 'customer_calculator', 'customer_orders', 'customer_topup', 'shared_api'];
const SHARED_PAGES   = ['shared_settings', 'shared_affiliates'];
const ALL_PAGES      = [...VENDOR_PAGES, ...CUSTOMER_PAGES, ...SHARED_PAGES];

function showPage(id) {
  ALL_PAGES.forEach(p => {
    const el = document.getElementById('page_' + p);
    if(el) el.style.display = (p === id) ? 'block' : 'none';
  });
  localStorage.setItem('rbxvault_current_page', id);
}

function switchMode(mode) {
  localStorage.setItem('rbxvault_mode', mode);
  fetch(BACKEND + '/api/set-role', {method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({role: mode === 'vendor' ? 'sell' : 'buy'})}).catch(()=>{});
  showPage(mode === 'vendor' ? 'vendor_overview' : 'customer_overview');
}

async function refreshBalance() {
  try {
    const res = await fetch(BACKEND + '/api/me', {credentials:'include'});
    const data = await res.json();
    if(!data.loggedIn){ localStorage.removeItem('rbxvault_session'); window.location.href='/'; return; }
    document.querySelectorAll('.rbxv-balance').forEach(el => { el.textContent = '$' + parseFloat(data.balance||0).toFixed(2); });
    document.querySelectorAll('.rbxv-username').forEach(el => { el.textContent = data.username; });
    document.querySelectorAll('.rbxv-avatar').forEach(el => {
      if(data.avatar) el.innerHTML = '<img src="'+data.avatar+'" style="width:100%;height:100%;object-fit:cover;border-radius:8px;">';
      else el.textContent = data.username[0].toUpperCase();
    });
    if(data.role && !localStorage.getItem('rbxvault_mode'))
      localStorage.setItem('rbxvault_mode', data.role === 'sell' ? 'vendor' : 'customer');
    localStorage.setItem('rbxvault_session', JSON.stringify({username:data.username,avatar:data.avatar||null}));
    settingsPopulate(data);
  } catch(e) { console.error(e); }
}

function doLogout() {
  localStorage.removeItem('rbxvault_session');
  localStorage.removeItem('rbxvault_mode');
  localStorage.removeItem('rbxvault_current_page');
  fetch(BACKEND + '/api/logout', {method:'POST',credentials:'include'}).catch(()=>{});
  window.location.href = '/';
}

document.addEventListener('DOMContentLoaded', function() {
  // Load part2 pages (customer + shared pages)
  fetch('/dashboard2.html')
    .then(r => r.text())
    .then(html => {
      const placeholder = document.getElementById('pages_part2_placeholder');
      if(placeholder) {
        placeholder.outerHTML = html;
      }
      refreshBalance();
      const saved = localStorage.getItem('rbxvault_current_page');
      const mode  = localStorage.getItem('rbxvault_mode') || 'customer';
      if(saved && ALL_PAGES.includes(saved)) showPage(saved);
      else showPage(mode === 'vendor' ? 'vendor_overview' : 'customer_overview');
    })
    .catch(e => {
      console.error('Failed to load dashboard2:', e);
      refreshBalance();
      showPage('vendor_overview');
    });
});

// ===== SETTINGS PAGE =====
function settingsPopulate(data) {
  const u = document.getElementById('settings_username');
  if(u) u.value = data.username || '';
  const nd = document.getElementById('settings_name_display');
  if(nd) nd.textContent = data.username || '';
  const ed = document.getElementById('settings_email_display');
  if(ed) ed.textContent = data.email || '';
  const av = document.getElementById('settings_avatar_url');
  if(av) av.value = data.avatar_url || '';
  // Avatar preview
  const img = document.getElementById('settings_avatar_img');
  const letter = document.getElementById('settings_avatar_letter');
  if(data.avatar) {
    if(img){ img.src = data.avatar; img.style.display='block'; }
    if(letter) letter.style.display='none';
  } else {
    if(img) img.style.display='none';
    if(letter){ letter.textContent = (data.username||'?')[0].toUpperCase(); letter.style.display='block'; }
  }
  const av_check = document.getElementById('settings_anon_vendor');
  if(av_check) av_check.checked = data.anon_vendor !== false;
  const ac_check = document.getElementById('settings_anon_customer');
  if(ac_check) ac_check.checked = data.anon_customer !== false;
}

async function settingsUpdateName(e) {
  e.preventDefault();
  const val = document.getElementById('settings_username').value.trim();
  if(val.length < 3 || val.length > 16) return toast('Username must be 3-16 characters.', 'error');
  if(!/^[a-zA-Z0-9_]+$/.test(val)) return toast('Letters, numbers, and underscores only.', 'error');
  const res = await fetch(BACKEND+'/api/settings/display-name',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({display_name:val})});
  const data = await res.json();
  if(!data.ok) return toast(data.error, 'error');
  document.querySelectorAll('.rbxv-username').forEach(el => el.textContent = data.username);
  const nd = document.getElementById('settings_name_display');
  if(nd) nd.textContent = data.username;
  const ls = JSON.parse(localStorage.getItem('rbxvault_session')||'{}');
  ls.username = data.username;
  localStorage.setItem('rbxvault_session', JSON.stringify(ls));
  toast('Name updated!', 'success');
}

async function settingsUpdatePrivacy(e) {
  e.preventDefault();
  const av = document.getElementById('settings_anon_vendor')?.checked !== false;
  const ac = document.getElementById('settings_anon_customer')?.checked !== false;
  const res = await fetch(BACKEND+'/api/settings/privacy',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({anon_vendor:av,anon_customer:ac})});
  const data = await res.json();
  if(!data.ok) return toast(data.error, 'error');
  toast('Privacy updated!', 'success');
}

async function settingsUpdateAvatar(e) {
  e.preventDefault();
  const url = document.getElementById('settings_avatar_url')?.value.trim();
  if(!url) return toast('Please enter an avatar URL.', 'error');
  const res = await fetch(BACKEND+'/api/settings/avatar',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({avatar_url:url})});
  const data = await res.json();
  if(!data.ok) return toast(data.error, 'error');
  document.querySelectorAll('.rbxv-avatar').forEach(el => {
    el.innerHTML = '<img src="'+url+'" style="width:100%;height:100%;object-fit:cover;border-radius:8px;">';
  });
  const img = document.getElementById('settings_avatar_img');
  if(img){ img.src=url; img.style.display='block'; }
  const ls = JSON.parse(localStorage.getItem('rbxvault_session')||'{}');
  ls.avatar = url;
  localStorage.setItem('rbxvault_session', JSON.stringify(ls));
  toast('Avatar updated!', 'success');
}

async function settingsRemoveAvatar(e) {
  e.preventDefault();
  const res = await fetch(BACKEND+'/api/settings/avatar',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({avatar_url:null})});
  const data = await res.json();
  if(!data.ok) return toast(data.error, 'error');
  const session = JSON.parse(localStorage.getItem('rbxvault_session')||'{}');
  const letter = (session.username||'?')[0].toUpperCase();
  document.querySelectorAll('.rbxv-avatar').forEach(el => { el.innerHTML = ''; el.textContent = letter; });
  const img = document.getElementById('settings_avatar_img');
  if(img){ img.src=''; img.style.display='none'; } const letter=document.getElementById('settings_avatar_letter'); if(letter){ letter.textContent=(session.username||'?')[0].toUpperCase(); letter.style.display='block'; }
  const av = document.getElementById('settings_avatar_url');
  if(av) av.value = '';
  const ls = JSON.parse(localStorage.getItem('rbxvault_session')||'{}');
  ls.avatar = null;
  localStorage.setItem('rbxvault_session', JSON.stringify(ls));
  toast('Avatar removed!', 'success');
}
