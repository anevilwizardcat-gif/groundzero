// ============================================================
//  MYTHBOUND — Shared Data Layer
//  Import this in every page: <script src="mythbound_shared.js"></script>
//  In production: replace MB.PLAYER reads/writes with Supabase calls.
// ============================================================

const MB = {};

// ── PLAYER STATE ─────────────────────────────────────────────
// Single source of truth for the logged-in player.
// Pages read MB.PLAYER; writes call MB.setPlayer(patch) so
// BroadcastChannel can sync across tabs.
MB.PLAYER = {
  id:         'raven',
  name:       'RAVEN',
  em:         '🐦‍⬛',
  title:      '',                  // set by account data
  level:      12,
  role:       'Striker',
  myth:       null,             // set by account data — never default
  coins:      4820,
  // Professions: level + xp toward next level
  professions: {
    fishing:      { level:4,  xp:420,  xpMax:1000 },
    mining:       { level:7,  xp:210,  xpMax:1000 },
    herbalism:    { level:1,  xp:0,    xpMax:100  },
    hunting:      { level:1,  xp:0,    xpMax:100  },
  },
  craft: 'blacksmithing',       // one craft per player; null = none chosen
  craftLevel: 3,
  craftXp: 80, craftXpMax: 300,
  energy:     800,
  energyMax:  1000,
  // Combat stats (used by battle page)
  hp: 110, mhp: 110,
  mp: 80,  mmp: 80,
  atk: 24, def: 14, spd: 14,
  lb: 0,
  row: 'front',
};

MB.setPlayer = function(patch) {
  Object.assign(MB.PLAYER, patch);
  MB.savePlayer();
  if (MB._BC) MB._BC.postMessage({ type:'player_update', data: MB.PLAYER });
};
// ── PERSISTENCE (localStorage → Supabase in production) ──────
// Per-account keying: every account has its own localStorage key.
// MB.SAVE_KEY is set dynamically from the signed-in session.
// To migrate to Supabase: replace the localStorage calls in
// savePlayer/loadPlayer with supabase table reads/writes.
// MB.setSession, MB.signOut, MB.isSignedIn all stay identical.

MB.SAVE_KEY = function() {
  const s = MB.getSession();
  if (s && s.name) return 'mythbound_player_v2_' + s.name.toUpperCase();
  return 'mythbound_player_v2_GUEST';
};

MB.savePlayer = function() {
  try {
    localStorage.setItem(MB.SAVE_KEY(), JSON.stringify(MB.PLAYER));
  } catch(e) { console.warn('[MB] save failed:', e); }
  if (MB.serverSavePlayer) MB.serverSavePlayer(); // debounced push to server
};

MB.loadPlayer = function() {
  // Step 1: get session (who is logged in)
  const session = MB.getSession();
  if (!session) return; // not signed in — leave MB.PLAYER as blank defaults

  // Step 2: load that account's saved game data
  try {
    // Always load fresh account definition first (ground truth for myth/title etc)
    const accounts = (function(){
      try { return JSON.parse(localStorage.getItem('mythbound_accounts_v1')) || {}; }
      catch(e) { return {}; }
    })();
    const acc = accounts[session.name.toUpperCase()];
    // Seed account-defined fields first (myth, title, role etc)
    if (acc) {
      const accSkip = ['password','bag','equipped','professions'];
      Object.keys(acc).forEach(k => {
        if (!accSkip.includes(k)) MB.PLAYER[k] = acc[k];
      });
      // myth is authoritative from account definition unless player has bound one via gameplay
      // (gameplay myth is stored in save data and will override below)
    }

    const raw = localStorage.getItem(MB.SAVE_KEY());
    if (raw) {
      // Account has saved game data — restore it, but let account definition
      // remain authoritative for fields not gameplay-changed
      const saved = JSON.parse(raw);
      const gameplayFields = ['coins','energy','energyMax','bag','equipped','professions',
                              'bagSlots','slotsUnlocked','lockedSlots','myth','mythId',
                              'craftLevel','craftXp','craft','hp','mp','atk','def','spd'];
      gameplayFields.forEach(k => {
        if (saved[k] !== undefined) MB.PLAYER[k] = saved[k];
      });
      if (saved.professions) {
        Object.keys(saved.professions).forEach(p => {
          MB.PLAYER.professions[p] = saved.professions[p];
        });
      }
      if (saved.bag) {
        // Sanitize bag — strip any full item objects back to {id, qty} only
        // This repairs any corruption from a previous hydratePlayer bug
        MB.PLAYER.bag = saved.bag
          .filter(i => i && i.id)
          .map(i => ({ id: i.id, qty: i.qty || 1 }));
      }
      if (saved.equipped) MB.PLAYER.equipped  = saved.equipped;
    } else if (acc) {
      // First login — seed gameplay data from account definition
      if (acc.professions) MB.PLAYER.professions = acc.professions;
      if (acc.bag)         MB.PLAYER.bag         = acc.bag;
      if (acc.equipped)    MB.PLAYER.equipped     = acc.equipped;
      MB.savePlayer(); // write initial save for this account
    }
  } catch(e) { console.warn('[MB] load failed:', e); }
};

// ── INVENTORY HELPERS ─────────────────────────────────────────
// Call these instead of mutating MB.PLAYER.bag directly.

MB.addToInventory = function(itemId, qty) {
  qty = qty || 1;
  if (!MB.PLAYER.bag) MB.PLAYER.bag = [];
  const existing = MB.PLAYER.bag.find(i => i.id === itemId);
  if (existing) {
    existing.qty = (existing.qty || 1) + qty;
  } else {
    // Store only id + qty — full item data is always read from MB.ITEMS at render time
    // This ensures data editor changes take effect immediately on next render
    MB.PLAYER.bag.push({ id: itemId, qty: qty });
  }
  MB.savePlayer();
};

MB.removeFromInventory = function(itemId, qty) {
  qty = qty || 1;
  if (!MB.PLAYER.bag) return;
  const idx = MB.PLAYER.bag.findIndex(i => i.id === itemId);
  if (idx === -1) return;
  const item = MB.PLAYER.bag[idx];
  item.qty = (item.qty || 1) - qty;
  if (item.qty <= 0) MB.PLAYER.bag.splice(idx, 1);
  MB.savePlayer();
};

MB.addXP = function(profession, amount) {
  const prof = MB.PLAYER.professions[profession];
  if (!prof) return;
  prof.xp += amount;
  while (prof.xp >= prof.xpMax && prof.level < 100) {
    prof.xp -= prof.xpMax;
    prof.level++;
    prof.xpMax = MB.xpForLevel(prof.level);
  }
  MB.savePlayer();
};

MB.setEnergy = function(val) {
  MB.PLAYER.energy = Math.max(0, Math.min(MB.PLAYER.energyMax, val));
  MB.savePlayer();
};

MB.addCoins = function(amount) {
  MB.PLAYER.coins = Math.max(0, MB.PLAYER.coins + amount);
  MB.savePlayer();
};

MB.resetSave = function() {
  localStorage.removeItem(MB.SAVE_KEY());
  location.reload();
};

// ── SERVER SYNC ───────────────────────────────────────────────
// The dev server (server.js) is the source of truth for accounts,
// player saves, and mail. localStorage is a per-browser cache that
// is refreshed authoritatively at LOGIN; during a session, saves are
// pushed to the server (debounced). If the server is unreachable,
// everything still works locally (localStorage fallback) so the game
// never hard-breaks offline.
//   To migrate to Supabase: point MB.SERVER at your project / swap
//   these fetches for supabase table calls. The call sites don't change.
MB.SERVER = (typeof location !== 'undefined' && location.origin && location.origin.startsWith('http'))
  ? location.origin : 'http://localhost:3000';

MB._sessionToken = function() {
  const s = MB.getSession();
  return s && s.token ? s.token : null;
};

// Push the current player save to the server (debounced ~1.5s).
MB._saveTimer = null;
MB._tradeLock = false; // when true, pause pushes so a trade's authoritative
                       // server result can't be clobbered by a stale local save
MB.serverSavePlayer = function() {
  if (typeof fetch === 'undefined') return;
  if (MB._tradeLock) return; // mid-trade: server owns the save
  const s = MB.getSession();
  if (!s || !s.name || !s.token) return; // not a server-backed session
  clearTimeout(MB._saveTimer);
  MB._saveTimer = setTimeout(() => {
    if (MB._tradeLock) return;
    fetch(MB.SERVER + '/__player/save', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name:s.name, token:s.token, player:MB.PLAYER }),
    }).then(r=>r.json()).then(res => {
      if (res && res.valid === false) MB._handleKicked();
    }).catch(()=>{}); // offline: localStorage already saved, will sync on next login
  }, 1500);
};

// Re-pull the authoritative save from the server into MB.PLAYER (gameplay
// fields only — identity stays as-is). Used after a trade so bags/coins
// reflect the swap the server just performed. Returns a promise.
MB.reloadPlayerFromServer = async function() {
  if (typeof fetch === 'undefined') return false;
  const s = MB.getSession();
  if (!s || !s.name) return false;
  try {
    const r = await fetch(MB.SERVER + '/__player/load?name=' + encodeURIComponent(s.name));
    if (!r.ok) return false;
    const save = await r.json();
    if (!save || typeof save !== 'object') return false;
    // Merge authoritative gameplay fields into the live player object.
    ['bag','coins','professions','equipped','craft','craftLevel','craftXp','stamina','myth','mythId']
      .forEach(k => { if (k in save) MB.PLAYER[k] = save[k]; });
    try { localStorage.setItem('mythbound_player_v2_' + s.name.toUpperCase(), JSON.stringify(MB.PLAYER)); } catch(e){}
    return true;
  } catch(e) { return false; }
};

// Called when the server says our session token is no longer active
// (someone else logged into this account). Kick to login once.
MB._kicked = false;
MB._handleKicked = function() {
  if (MB._kicked) return;
  MB._kicked = true;
  try { localStorage.setItem('mythbound_kick_reason','This account was signed in from another location.'); } catch(e){}
  try { localStorage.removeItem('mythbound_session_v1'); } catch(e){}
  if (typeof window !== 'undefined') window.location.href = 'mythbound_auth.html';
};

// Pull the authoritative account+save+mail from the server and write them
// into localStorage in the shape the rest of the app expects. Used at login.
MB.applyServerLogin = function(res) {
  // res = { user, token, save, mail }
  const NAME = res.user.name.toUpperCase();
  // 1) accounts store (identity / ground-truth fields)
  try {
    const accts = JSON.parse(localStorage.getItem('mythbound_accounts_v1') || '{}');
    accts[NAME] = Object.assign({}, accts[NAME], res.user);
    localStorage.setItem('mythbound_accounts_v1', JSON.stringify(accts));
  } catch(e){}
  // 2) gameplay save
  try { if (res.save) localStorage.setItem('mythbound_player_v2_' + NAME, JSON.stringify(res.save)); } catch(e){}
  // 3) mailbox cache
  try { if (res.mail) localStorage.setItem('mythbound_mail_v2_' + NAME, JSON.stringify(res.mail)); } catch(e){}
  // 4) session (carries the token)
  MB.setSession(Object.assign({}, res.user, { token: res.token }));
};

// Server-backed mail helpers (used by mail page + hub admin). Each falls
// back to localStorage if the server is unreachable.
MB.serverMailList = async function(name) {
  const NAME = (name || (MB.getSession()||{}).name || '').toUpperCase();
  try {
    const r = await fetch(MB.SERVER + '/__mail/list?name=' + encodeURIComponent(NAME));
    if (r.ok) return await r.json();
  } catch(e){}
  // fallback: localStorage cache
  try { return JSON.parse(localStorage.getItem('mythbound_mail_v2_' + NAME) || '[]'); } catch(e){ return []; }
};
MB.serverMailSend = async function(to, mail) {
  try {
    const r = await fetch(MB.SERVER + '/__mail/send', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ to, mail }),
    });
    if (r.ok) return await r.json();
  } catch(e){}
  return { ok:false };
};
MB.serverMailSave = async function(mail) {
  const s = MB.getSession();
  if (!s || !s.name || !s.token) return { ok:false };
  // cache locally immediately
  try { localStorage.setItem('mythbound_mail_v2_' + s.name.toUpperCase(), JSON.stringify(mail)); } catch(e){}
  try {
    const r = await fetch(MB.SERVER + '/__mail/save', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name:s.name, token:s.token, mail }),
    });
    if (r.ok) { const res = await r.json(); if (res.valid===false) MB._handleKicked(); return res; }
  } catch(e){}
  return { ok:false };
};


// MB.loadPlayer() is called at the END of this file after all functions are defined.



// ── BROADCAST CHANNEL ────────────────────────────────────────
// Same-origin cross-tab sync. In production → Supabase Realtime.
MB._BC = (() => {
  try { return new BroadcastChannel('mythbound_main'); } catch(e) { return null; }
})();
MB._bcListeners = [];
MB.onBC = function(fn) { MB._bcListeners.push(fn); };
if (MB._BC) {
  MB._BC.onmessage = e => MB._bcListeners.forEach(fn => fn(e.data));
}


// ── ITEM SPRITES ─────────────────────────────────────────────
// Each sprite is a 16×16 SVG string. Colors are flat pixel art.
// To add/change a sprite: edit MB.SPRITES[itemId] = '<svg>...</svg>'
// MB.getSprite(id) returns the sprite or the UNKNOWN fallback.
// MB.renderItemIcon(id, sizePx) returns a sized HTML string for use in any page.

MB.SPRITES = {};

// ── HELPER: make a 16x16 SVG from a pixel grid ───────────────
// pixels = array of {x,y,c} where c is hex color
// Or pass a compact string map (see usage below)
MB._svg = function(pixels, bg) {
  bg = bg || 'none';
  const cells = pixels.map(p =>
    `<rect x="${p.x}" y="${p.y}" width="1" height="1" fill="${p.c}"/>`
  ).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">`
    + (bg !== 'none' ? `<rect width="16" height="16" fill="${bg}"/>` : '')
    + cells + `</svg>`;
};

// Shorthand: array of [x, y, color] triples
MB._px = function(triples, bg) {
  return MB._svg(triples.map(t => ({x:t[0],y:t[1],c:t[2]})), bg);
};

// ── UNKNOWN / UNDEFINED ITEM ──────────────────────────────────
MB.SPRITES['?'] = MB._px([
  // Purple question mark on dark bg
  [5,2,'#c455e8'],[6,2,'#c455e8'],[7,2,'#c455e8'],[8,2,'#c455e8'],[9,2,'#c455e8'],
  [4,3,'#c455e8'],[10,3,'#c455e8'],
  [9,4,'#c455e8'],[10,4,'#c455e8'],
  [7,5,'#c455e8'],[8,5,'#c455e8'],[9,5,'#c455e8'],
  [6,6,'#c455e8'],[7,6,'#c455e8'],
  [6,7,'#c455e8'],[7,7,'#c455e8'],
  [6,9,'#c455e8'],[7,9,'#c455e8'],
  [6,10,'#c455e8'],[7,10,'#c455e8'],
], '#111');

// ── ORE / ROCK MATERIALS ──────────────────────────────────────
MB.SPRITES['stone'] = MB._px([
  [4,3,'#777'],[5,3,'#888'],[6,3,'#888'],[7,3,'#999'],[8,3,'#888'],[9,3,'#777'],
  [3,4,'#777'],[4,4,'#aaa'],[5,4,'#999'],[6,4,'#aaa'],[7,4,'#bbb'],[8,4,'#999'],[9,4,'#888'],[10,4,'#777'],
  [3,5,'#888'],[4,5,'#999'],[5,5,'#bbb'],[6,5,'#999'],[7,5,'#aaa'],[8,5,'#bbb'],[9,5,'#999'],[10,5,'#888'],
  [3,6,'#888'],[4,6,'#aaa'],[5,6,'#999'],[6,6,'#bbb'],[7,6,'#aaa'],[8,6,'#999'],[9,6,'#888'],[10,6,'#777'],
  [3,7,'#777'],[4,7,'#888'],[5,7,'#999'],[6,7,'#aaa'],[7,7,'#999'],[8,7,'#888'],[9,7,'#777'],
  [4,8,'#666'],[5,8,'#777'],[6,8,'#888'],[7,8,'#777'],[8,8,'#666'],[9,8,'#666'],
  [5,9,'#555'],[6,9,'#666'],[7,9,'#666'],[8,9,'#555'],
], 'none');

MB.SPRITES['copper_ore'] = MB._px([
  [4,3,'#555'],[5,3,'#666'],[6,3,'#777'],[7,3,'#666'],[8,3,'#555'],
  [3,4,'#555'],[4,4,'#888'],[5,4,'#e8631a'],[6,4,'#ff7733'],[7,4,'#e8631a'],[8,4,'#888'],[9,4,'#555'],
  [3,5,'#666'],[4,5,'#e8631a'],[5,5,'#ff9955'],[6,5,'#ffaa66'],[7,5,'#ff7733'],[8,5,'#e8631a'],[9,5,'#666'],
  [3,6,'#666'],[4,6,'#cc5500'],[5,6,'#e8631a'],[6,6,'#ff7733'],[7,6,'#e8631a'],[8,6,'#cc5500'],[9,6,'#555'],
  [3,7,'#555'],[4,7,'#888'],[5,7,'#cc5500'],[6,7,'#e8631a'],[7,7,'#cc5500'],[8,7,'#888'],[9,7,'#555'],
  [4,8,'#555'],[5,8,'#666'],[6,8,'#777'],[7,8,'#666'],[8,8,'#555'],
], 'none');

MB.SPRITES['tin_ore'] = MB._px([
  [4,3,'#555'],[5,3,'#777'],[6,3,'#888'],[7,3,'#777'],[8,3,'#555'],
  [3,4,'#555'],[4,4,'#888'],[5,4,'#b0b0b0'],[6,4,'#d0d0d0'],[7,4,'#b0b0b0'],[8,4,'#888'],[9,4,'#555'],
  [3,5,'#666'],[4,5,'#b0b0b0'],[5,5,'#ddd'],[6,5,'#eee'],[7,5,'#ccc'],[8,5,'#b0b0b0'],[9,5,'#666'],
  [3,6,'#666'],[4,6,'#999'],[5,6,'#b0b0b0'],[6,6,'#ccc'],[7,6,'#b0b0b0'],[8,6,'#999'],[9,6,'#555'],
  [3,7,'#555'],[4,7,'#777'],[5,7,'#999'],[6,7,'#aaa'],[7,7,'#999'],[8,7,'#777'],[9,7,'#555'],
  [4,8,'#444'],[5,8,'#666'],[6,8,'#777'],[7,8,'#666'],[8,8,'#444'],
], 'none');

MB.SPRITES['iron_ore'] = MB._px([
  [4,3,'#555'],[5,3,'#666'],[6,3,'#777'],[7,3,'#666'],[8,3,'#555'],
  [3,4,'#555'],[4,4,'#777'],[5,4,'#a08070'],[6,4,'#c09080'],[7,4,'#a08070'],[8,4,'#777'],[9,4,'#555'],
  [3,5,'#666'],[4,5,'#a08070'],[5,5,'#c8a090'],[6,5,'#d0a888'],[7,5,'#b89080'],[8,5,'#a08070'],[9,5,'#666'],
  [3,6,'#666'],[4,6,'#8a6050'],[5,6,'#a08070'],[6,6,'#b88870'],[7,6,'#a08070'],[8,6,'#8a6050'],[9,6,'#555'],
  [3,7,'#555'],[4,7,'#777'],[5,7,'#8a6050'],[6,7,'#a08070'],[7,7,'#8a6050'],[8,7,'#777'],[9,7,'#555'],
  [4,8,'#444'],[5,8,'#555'],[6,8,'#666'],[7,8,'#555'],[8,8,'#444'],
], 'none');

MB.SPRITES['coal'] = MB._px([
  [4,3,'#222'],[5,3,'#333'],[6,3,'#333'],[7,3,'#222'],
  [3,4,'#222'],[4,4,'#444'],[5,4,'#555'],[6,4,'#555'],[7,4,'#444'],[8,4,'#222'],
  [3,5,'#222'],[4,5,'#444'],[5,5,'#666'],[6,5,'#555'],[7,5,'#444'],[8,5,'#333'],[9,5,'#222'],
  [3,6,'#333'],[4,6,'#555'],[5,6,'#555'],[6,6,'#666'],[7,6,'#555'],[8,6,'#444'],[9,6,'#222'],
  [3,7,'#222'],[4,7,'#444'],[5,7,'#444'],[6,7,'#555'],[7,7,'#444'],[8,7,'#333'],
  [4,8,'#222'],[5,8,'#333'],[6,8,'#444'],[7,8,'#333'],[8,8,'#222'],
  // highlight
  [5,4,'#777'],[6,5,'#777'],
], 'none');

MB.SPRITES['silver_ore'] = MB._px([
  [4,3,'#555'],[5,3,'#888'],[6,3,'#aaa'],[7,3,'#888'],[8,3,'#555'],
  [3,4,'#555'],[4,4,'#999'],[5,4,'#ccc'],[6,4,'#eee'],[7,4,'#ccc'],[8,4,'#999'],[9,4,'#555'],
  [3,5,'#666'],[4,5,'#bbb'],[5,5,'#ddd'],[6,5,'#fff'],[7,5,'#eee'],[8,5,'#bbb'],[9,5,'#666'],
  [3,6,'#666'],[4,6,'#999'],[5,6,'#bbb'],[6,6,'#ddd'],[7,6,'#bbb'],[8,6,'#999'],[9,6,'#555'],
  [3,7,'#555'],[4,7,'#777'],[5,7,'#999'],[6,7,'#bbb'],[7,7,'#999'],[8,7,'#777'],[9,7,'#444'],
  [4,8,'#444'],[5,8,'#666'],[6,8,'#777'],[7,8,'#666'],[8,8,'#444'],
], 'none');

MB.SPRITES['quartz'] = MB._px([
  [7,2,'#eee'],[8,2,'#fff'],
  [6,3,'#ddd'],[7,3,'#fff'],[8,3,'#eee'],[9,3,'#ccc'],
  [5,4,'#bbb'],[6,4,'#eee'],[7,4,'#fff'],[8,4,'#ddd'],[9,4,'#bbb'],[10,4,'#aaa'],
  [5,5,'#aaa'],[6,5,'#ccc'],[7,5,'#eee'],[8,5,'#fff'],[9,5,'#ccc'],[10,5,'#aaa'],
  [4,6,'#888'],[5,6,'#bbb'],[6,6,'#ddd'],[7,6,'#eee'],[8,6,'#ccc'],[9,6,'#aaa'],[10,6,'#888'],
  [4,7,'#777'],[5,7,'#999'],[6,7,'#bbb'],[7,7,'#ccc'],[8,7,'#aaa'],[9,7,'#888'],
  [5,8,'#666'],[6,8,'#888'],[7,8,'#999'],[8,8,'#777'],[9,8,'#666'],
  [6,9,'#555'],[7,9,'#666'],[8,9,'#555'],
], 'none');

MB.SPRITES['mithril_ore'] = MB._px([
  [5,3,'#3a6a88'],[6,3,'#5599bb'],[7,3,'#77bbdd'],[8,3,'#5599bb'],[9,3,'#3a6a88'],
  [4,4,'#3a6a88'],[5,4,'#5599bb'],[6,4,'#88ccee'],[7,4,'#aaddff'],[8,4,'#88ccee'],[9,4,'#5599bb'],[10,4,'#3a6a88'],
  [4,5,'#446688'],[5,5,'#77aacc'],[6,5,'#99ddff'],[7,5,'#bbeeFF'],[8,5,'#99ccee'],[9,5,'#6699bb'],[10,5,'#446688'],
  [4,6,'#3a6a88'],[5,6,'#5588aa'],[6,6,'#88bbdd'],[7,6,'#aaccee'],[8,6,'#88aacc'],[9,6,'#5588aa'],[10,6,'#3a5577'],
  [5,7,'#335577'],[6,7,'#5588aa'],[7,7,'#77aacc'],[8,7,'#5588aa'],[9,7,'#335577'],
  [6,8,'#224466'],[7,8,'#4477aa'],[8,8,'#224466'],
  // sparkle
  [7,2,'#cceeFF'],[11,5,'#bbddff'],[3,7,'#aaccee'],
], 'none');

MB.SPRITES['geode'] = MB._px([
  [5,2,'#9955bb'],[6,2,'#aa66cc'],[7,2,'#bb77dd'],[8,2,'#aa66cc'],[9,2,'#9955bb'],
  [4,3,'#8844aa'],[5,3,'#bb88dd'],[6,3,'#cc44ff'],[7,3,'#dd66ff'],[8,3,'#cc44ff'],[9,3,'#bb88dd'],[10,3,'#8844aa'],
  [3,4,'#7733aa'],[4,4,'#aa77cc'],[5,4,'#cc88ee'],[6,4,'#ff88ff'],[7,4,'#ffaaff'],[8,4,'#ee66ff'],[9,4,'#cc44ee'],[10,4,'#aa66cc'],[11,4,'#7733aa'],
  [3,5,'#8844bb'],[4,5,'#aa66cc'],[5,5,'#cc44ff'],[6,5,'#ffaaff'],[7,5,'#ffccff'],[8,5,'#ff88ff'],[9,5,'#cc44ee'],[10,5,'#aa66cc'],[11,5,'#7733aa'],
  [3,6,'#7733aa'],[4,6,'#9955cc'],[5,6,'#bb77dd'],[6,6,'#dd88ff'],[7,6,'#eea0ff'],[8,6,'#cc66ee'],[9,6,'#aa44cc'],[10,6,'#8833aa'],[11,6,'#6622aa'],
  [4,7,'#6622aa'],[5,7,'#8844bb'],[6,7,'#aa55cc'],[7,7,'#cc77ee'],[8,7,'#aa55cc'],[9,7,'#8833aa'],[10,7,'#6622aa'],
  [5,8,'#551199'],[6,8,'#7733bb'],[7,8,'#9944cc'],[8,8,'#7733bb'],[9,8,'#551199'],
  [6,9,'#440099'],[7,9,'#6622aa'],[8,9,'#440099'],
], 'none');

// ── INGOTS / PROCESSED ───────────────────────────────────────
MB.SPRITES['iron_ingot'] = MB._px([
  [3,5,'#777'],[4,5,'#999'],[5,5,'#aaa'],[6,5,'#bbb'],[7,5,'#aaa'],[8,5,'#999'],[9,5,'#888'],[10,5,'#777'],
  [3,6,'#666'],[4,6,'#888'],[5,6,'#aaa'],[6,6,'#bbb'],[7,6,'#aaa'],[8,6,'#999'],[9,6,'#888'],[10,6,'#777'],[11,6,'#666'],
  [3,7,'#555'],[4,7,'#777'],[5,7,'#888'],[6,7,'#999'],[7,7,'#888'],[8,7,'#777'],[9,7,'#777'],[10,7,'#666'],[11,7,'#555'],
  [3,8,'#444'],[4,8,'#666'],[5,8,'#777'],[6,8,'#888'],[7,8,'#777'],[8,8,'#666'],[9,8,'#666'],[10,8,'#555'],[11,8,'#444'],
  [4,9,'#555'],[5,9,'#666'],[6,9,'#777'],[7,9,'#666'],[8,9,'#555'],[9,9,'#555'],[10,9,'#444'],
], 'none');

MB.SPRITES['silver_ingot'] = MB._px([
  [3,5,'#999'],[4,5,'#bbb'],[5,5,'#ddd'],[6,5,'#eee'],[7,5,'#ddd'],[8,5,'#bbb'],[9,5,'#aaa'],[10,5,'#999'],
  [3,6,'#888'],[4,6,'#aaa'],[5,6,'#ccc'],[6,6,'#eee'],[7,6,'#ddd'],[8,6,'#ccc'],[9,6,'#bbb'],[10,6,'#aaa'],[11,6,'#888'],
  [3,7,'#777'],[4,7,'#999'],[5,7,'#bbb'],[6,7,'#ccc'],[7,7,'#bbb'],[8,7,'#aaa'],[9,7,'#999'],[10,7,'#888'],[11,7,'#777'],
  [3,8,'#666'],[4,8,'#888'],[5,8,'#999'],[6,8,'#aaa'],[7,8,'#999'],[8,8,'#888'],[9,8,'#888'],[10,8,'#777'],[11,8,'#666'],
  [4,9,'#777'],[5,9,'#888'],[6,9,'#999'],[7,9,'#888'],[8,9,'#777'],[9,9,'#777'],[10,9,'#666'],
], 'none');

MB.SPRITES['mithril_bar'] = MB._px([
  [3,5,'#3a6a88'],[4,5,'#5599bb'],[5,5,'#77bbdd'],[6,5,'#99ccee'],[7,5,'#77bbdd'],[8,5,'#5599bb'],[9,5,'#4488aa'],[10,5,'#3a6a88'],
  [3,6,'#335577'],[4,6,'#4488aa'],[5,6,'#66aacc'],[6,6,'#88ccee'],[7,6,'#66aacc'],[8,6,'#4488aa'],[9,6,'#3377aa'],[10,6,'#335577'],[11,6,'#224466'],
  [3,7,'#224466'],[4,7,'#335577'],[5,7,'#4477aa'],[6,7,'#6699cc'],[7,7,'#4477aa'],[8,7,'#335577'],[9,7,'#335577'],[10,7,'#224466'],[11,7,'#224466'],
  [3,8,'#112233'],[4,8,'#224466'],[5,8,'#335577'],[6,8,'#446688'],[7,8,'#335577'],[8,8,'#224466'],[9,8,'#224466'],[10,8,'#112233'],
  [4,9,'#224466'],[5,9,'#335577'],[6,9,'#446688'],[7,9,'#335577'],[8,9,'#224466'],[9,9,'#112233'],
], 'none');

MB.SPRITES['adamant_frag'] = MB._px([
  [7,2,'#7ba8c4'],[8,2,'#9bc8e4'],
  [6,3,'#6698b4'],[7,3,'#8ab8d4'],[8,3,'#aad8f4'],[9,3,'#88b8d0'],
  [5,4,'#5588a4'],[6,4,'#7aabcc'],[7,4,'#99ccee'],[8,4,'#bbddff'],[9,4,'#99bbdd'],[10,4,'#7799bb'],
  [5,5,'#4477aa'],[6,5,'#6699cc'],[7,5,'#88bbee'],[8,5,'#aaccff'],[9,5,'#8899cc'],[10,5,'#6688aa'],
  [5,6,'#335588'],[6,6,'#5577aa'],[7,6,'#6688cc'],[8,6,'#7799dd'],[9,6,'#6677aa'],[10,6,'#445588'],
  [6,7,'#334477'],[7,7,'#445599'],[8,7,'#5566aa'],[9,7,'#334477'],
  [7,8,'#223366'],[8,8,'#334488'],
], 'none');

// ── SLIME DROPS ───────────────────────────────────────────────
MB.SPRITES['slime_glob'] = MB._px([
  [5,4,'#44aa44'],[6,4,'#66cc66'],[7,4,'#55bb55'],[8,4,'#44aa44'],
  [4,5,'#33aa33'],[5,5,'#66dd66'],[6,5,'#88ee88'],[7,5,'#77dd77'],[8,5,'#55bb55'],[9,5,'#33aa33'],
  [4,6,'#44bb44'],[5,6,'#77ee77'],[6,6,'#99ff99'],[7,6,'#88ee88'],[8,6,'#66cc66'],[9,6,'#44aa44'],
  [4,7,'#33aa33'],[5,7,'#55cc55'],[6,7,'#77dd77'],[7,7,'#66cc66'],[8,7,'#55bb55'],[9,7,'#33aa33'],
  [5,8,'#228822'],[6,8,'#44aa44'],[7,8,'#55bb55'],[8,8,'#44aa44'],[9,8,'#228822'],
  [6,9,'#117711'],[7,9,'#228822'],[8,9,'#117711'],
  // highlight
  [5,5,'#aaffaa'],[6,5,'#bbffbb'],
], 'none');

MB.SPRITES['slime_resin'] = MB._px([
  [6,3,'#336633'],[7,3,'#448844'],[8,3,'#336633'],
  [5,4,'#228822'],[6,4,'#55aa55'],[7,4,'#77cc77'],[8,4,'#55aa55'],[9,4,'#228822'],
  [5,5,'#339933'],[6,5,'#66bb66'],[7,5,'#88dd88'],[8,5,'#66bb66'],[9,5,'#339933'],
  [5,6,'#228822'],[6,6,'#44aa44'],[7,6,'#66bb66'],[8,6,'#55aa55'],[9,6,'#228822'],
  [5,7,'#117711'],[6,7,'#33aa33'],[7,7,'#55bb55'],[8,7,'#44aa44'],[9,7,'#117711'],
  [6,8,'#226622'],[7,8,'#44aa44'],[8,8,'#336633'],
  // amber resin color
  [6,5,'#aacc44'],[7,5,'#ccee66'],[8,5,'#aacc44'],
  [6,6,'#88aa33'],[7,6,'#aacc44'],
], 'none');

MB.SPRITES['slime_crown'] = MB._px([
  // Crown shape — legendary gold + green slime
  [5,2,'#ffdd6b'],[7,2,'#ffdd6b'],[9,2,'#ffdd6b'],
  [5,3,'#ffdd6b'],[6,3,'#ffdd6b'],[7,3,'#ffdd6b'],[8,3,'#ffdd6b'],[9,3,'#ffdd6b'],
  [4,4,'#ffcc44'],[5,4,'#ffee88'],[6,4,'#ffcc44'],[7,4,'#ffee88'],[8,4,'#ffcc44'],[9,4,'#ffee88'],[10,4,'#ffcc44'],
  [4,5,'#ddaa22'],[5,5,'#ffcc44'],[6,5,'#ddaa22'],[7,5,'#ffcc44'],[8,5,'#ddaa22'],[9,5,'#ffcc44'],[10,5,'#ddaa22'],
  [4,6,'#cc9900'],[5,6,'#ddaa22'],[6,6,'#cc9900'],[7,6,'#ddaa22'],[8,6,'#cc9900'],[9,6,'#ddaa22'],[10,6,'#cc9900'],
  // slime drip
  [5,7,'#55bb55'],[6,7,'#77cc55'],[7,7,'#55aa44'],[8,7,'#44aa44'],
  [6,8,'#44aa33'],[7,8,'#55bb44'],
  [6,9,'#228822'],[7,9,'#33aa33'],
  // gems
  [5,3,'#44ddff'],[7,3,'#ff44aa'],[9,3,'#44ddff'],
], 'none');

// ── GOLEM DROPS ───────────────────────────────────────────────
MB.SPRITES['rubble'] = MB._px([
  [3,6,'#666'],[4,6,'#777'],[5,6,'#888'],
  [3,7,'#555'],[4,7,'#777'],[5,7,'#888'],[6,7,'#777'],[7,7,'#666'],
  [4,8,'#555'],[5,8,'#666'],[6,8,'#777'],[7,8,'#666'],[8,8,'#555'],
  [5,9,'#444'],[6,9,'#555'],[7,9,'#666'],[8,9,'#555'],[9,9,'#444'],
  [7,6,'#888'],[8,6,'#777'],[9,6,'#666'],[10,6,'#555'],
  [8,7,'#777'],[9,7,'#888'],[10,7,'#777'],[11,7,'#666'],
  [9,8,'#666'],[10,8,'#777'],[11,8,'#666'],
  [2,8,'#666'],[3,8,'#555'],[2,9,'#555'],[3,9,'#666'],
], 'none');

MB.SPRITES['golem_core'] = MB._px([
  [6,3,'#334488'],[7,3,'#4455aa'],[8,3,'#334488'],
  [5,4,'#334488'],[6,4,'#5577cc'],[7,4,'#6688ee'],[8,4,'#5577cc'],[9,4,'#334488'],
  [4,5,'#223377'],[5,5,'#4466bb'],[6,5,'#6688ee'],[7,5,'#88aaff'],[8,5,'#6688ee'],[9,5,'#4466bb'],[10,5,'#223377'],
  [4,6,'#334488'],[5,6,'#5577cc'],[6,6,'#7799ff'],[7,6,'#99bbff'],[8,6,'#7799ff'],[9,6,'#5577cc'],[10,6,'#334488'],
  [4,7,'#223377'],[5,7,'#4466bb'],[6,7,'#6688ee'],[7,7,'#7799ff'],[8,7,'#6688ee'],[9,7,'#4466bb'],[10,7,'#223377'],
  [5,8,'#334488'],[6,8,'#5577cc'],[7,8,'#6688ee'],[8,8,'#5577cc'],[9,8,'#334488'],
  [6,9,'#223377'],[7,9,'#4455aa'],[8,9,'#223377'],
  // glow pulse represented by center highlight
  [7,6,'#ccddff'],[7,5,'#bbccff'],
], 'none');

MB.SPRITES['runed_heart'] = MB._px([
  [4,4,'#cc3344'],[5,4,'#ee4455'],[8,4,'#ee4455'],[9,4,'#cc3344'],
  [3,5,'#bb2233'],[4,5,'#ee5566'],[5,5,'#ff6677'],[6,5,'#ff7788'],[7,5,'#ff7788'],[8,5,'#ff6677'],[9,5,'#ee4455'],[10,5,'#bb2233'],
  [3,6,'#cc3344'],[4,6,'#ff6677'],[5,6,'#ff8899'],[6,6,'#ffaabb'],[7,6,'#ffaabb'],[8,6,'#ff8899'],[9,6,'#ff6677'],[10,6,'#cc3344'],
  [3,7,'#cc3344'],[4,7,'#ee5566'],[5,7,'#ff7788'],[6,7,'#ff99aa'],[7,7,'#ff99aa'],[8,7,'#ff7788'],[9,7,'#ee5566'],[10,7,'#cc3344'],
  [4,8,'#bb2233'],[5,8,'#ee5566'],[6,8,'#ff7788'],[7,8,'#ff7788'],[8,8,'#ee5566'],[9,8,'#bb2233'],
  [5,9,'#cc3344'],[6,9,'#ee5566'],[7,9,'#ee5566'],[8,9,'#cc3344'],
  [6,10,'#bb2233'],[7,10,'#cc3344'],
  // runes
  [5,6,'#ffeeaa'],[6,6,'#ffffcc'],[7,6,'#ffeeaa'],
  [5,7,'#ffddaa'],[7,7,'#ffddaa'],
], 'none');

// ── CHEST DROPS ───────────────────────────────────────────────
MB.SPRITES['gold_pile'] = MB._px([
  [5,7,'#cc9900'],[6,7,'#ffcc00'],[7,7,'#ffdd22'],[8,7,'#ffcc00'],[9,7,'#cc9900'],
  [4,8,'#cc8800'],[5,8,'#ffcc00'],[6,8,'#ffee44'],[7,8,'#ffdd22'],[8,8,'#ffcc00'],[9,8,'#ffcc00'],[10,8,'#cc9900'],
  [3,9,'#aa7700'],[4,9,'#ddaa00'],[5,9,'#ffcc00'],[6,9,'#ffee44'],[7,9,'#ffdd22'],[8,9,'#ffcc00'],[9,9,'#ddaa00'],[10,9,'#aa7700'],[11,9,'#996600'],
  [3,10,'#996600'],[4,10,'#bb9900'],[5,10,'#ddaa00'],[6,10,'#ffbb00'],[7,10,'#ffcc00'],[8,10,'#ddaa00'],[9,10,'#bb9900'],[10,10,'#996600'],
  [4,11,'#886600'],[5,11,'#aa8800'],[6,11,'#cc9900'],[7,11,'#cc9900'],[8,11,'#aa8800'],[9,11,'#886600'],
  // coins
  [6,7,'#ffee66'],[7,8,'#ffee44'],
], 'none');

MB.SPRITES['gem_cache'] = MB._px([
  [5,4,'#4488cc'],[7,4,'#cc4488'],[9,4,'#44cc88'],
  [4,5,'#3377bb'],[5,5,'#66aaee'],[6,5,'#88ccff'],[7,5,'#cc3377'],[8,5,'#ff66aa'],[9,5,'#33bb77'],[10,5,'#66ee99'],
  [4,6,'#2266aa'],[5,6,'#55aadd'],[6,6,'#77bbff'],[7,6,'#aa2266'],[8,6,'#dd5599'],[9,6,'#22aa66'],[10,6,'#44dd88'],
  [5,7,'#3377cc'],[6,7,'#5599ee'],[7,7,'#cc3388'],[8,7,'#ff55aa'],[9,7,'#33cc77'],
  [6,8,'#4488dd'],[7,8,'#dd4499'],[8,8,'#44dd88'],
], 'none');

MB.SPRITES['ancient_relic'] = MB._px([
  [6,2,'#bbaa77'],[7,2,'#ddc988'],[8,2,'#bbaa77'],
  [5,3,'#aa9966'],[6,3,'#ccbb88'],[7,3,'#eedd99'],[8,3,'#ccbb88'],[9,3,'#aa9966'],
  [4,4,'#998855'],[5,4,'#bbaa77'],[6,4,'#ddcc99'],[7,4,'#ffeeaa'],[8,4,'#ddcc99'],[9,4,'#bbaa77'],[10,4,'#998855'],
  [4,5,'#887744'],[5,5,'#aa9966'],[6,5,'#ccbb88'],[7,5,'#eedd99'],[8,5,'#ccbb88'],[9,5,'#aa9966'],[10,5,'#887744'],
  [4,6,'#776633'],[5,6,'#998855'],[6,6,'#bbaa77'],[7,6,'#ccbb88'],[8,6,'#bbaa77'],[9,6,'#998855'],[10,6,'#776633'],
  [5,7,'#665522'],[6,7,'#887744'],[7,7,'#aa9966'],[8,7,'#998855'],[9,7,'#776633'],
  [6,8,'#554411'],[7,8,'#776633'],[8,8,'#665522'],
  // rune marks
  [6,4,'#ff9900'],[7,4,'#ffaa22'],[8,4,'#ff9900'],
  [6,5,'#cc7700'],[7,5,'#ee9900'],[8,5,'#cc7700'],
  [6,6,'#aa5500'],[7,6,'#cc7700'],
], 'none');

// ── FISH ──────────────────────────────────────────────────────
// Generic fish body used as base for variations
MB.SPRITES['perch'] = MB._px([
  [10,6,'#cc8833'],[11,6,'#dd9944'],
  [5,7,'#cc7722'],[6,7,'#dd8833'],[7,7,'#ee9944'],[8,7,'#eeaa55'],[9,7,'#dd9944'],[10,7,'#dd9944'],[11,7,'#bbbb55'],
  [4,8,'#bb6611'],[5,8,'#dd8833'],[6,8,'#eeaa55'],[7,8,'#ffbb66'],[8,8,'#ffcc77'],[9,8,'#eebb66'],[10,8,'#dd9944'],[11,8,'#cc8833'],
  [4,9,'#aa5500'],[5,9,'#cc7722'],[6,9,'#dd9944'],[7,9,'#eeaa55'],[8,9,'#eebb55'],[9,9,'#ddaa44'],[10,9,'#cc8833'],
  [5,10,'#994400'],[6,10,'#bb6611'],[7,10,'#cc8833'],[8,10,'#cc7722'],[9,10,'#bb6611'],
  [3,8,'#994400'],[3,9,'#883300'],
  // eye
  [9,7,'#111'],[9,8,'#fff'],
  // fin
  [6,6,'#ee9933'],[7,6,'#ffaa44'],[8,6,'#ee9933'],
  [7,5,'#dd8822'],
], 'none');

MB.SPRITES['roach'] = MB._px([
  [9,6,'#4488cc'],[10,6,'#55aadd'],
  [5,7,'#3377bb'],[6,7,'#4499cc'],[7,7,'#55aadd'],[8,7,'#66bbee'],[9,7,'#66bbee'],[10,7,'#4499cc'],
  [4,8,'#2266aa'],[5,8,'#3388cc'],[6,8,'#44aadd'],[7,8,'#55bbee'],[8,8,'#66ccff'],[9,8,'#55bbee'],[10,8,'#4499cc'],
  [4,9,'#2255aa'],[5,9,'#3377bb'],[6,9,'#4499cc'],[7,9,'#55aadd'],[8,9,'#55aadd'],[9,9,'#3388bb'],
  [5,10,'#224499'],[6,10,'#3366aa'],[7,10,'#4488bb'],[8,10,'#3377aa'],
  [3,8,'#224499'],[3,9,'#113388'],
  [9,7,'#111'],[9,8,'#fff'],
  [6,6,'#4499cc'],[7,6,'#55aadd'],[7,5,'#3388bb'],
], 'none');

MB.SPRITES['carp'] = MB._px([
  [9,6,'#888844'],[10,6,'#aaaa55'],
  [4,7,'#777733'],[5,7,'#999944'],[6,7,'#aaaa55'],[7,7,'#bbbb66'],[8,7,'#cccc77'],[9,7,'#bbbb66'],[10,7,'#999944'],
  [3,8,'#666633'],[4,8,'#888844'],[5,8,'#aaaa55'],[6,8,'#cccc77'],[7,8,'#dddd88'],[8,8,'#cccc77'],[9,8,'#bbbb66'],[10,8,'#999944'],
  [3,9,'#777733'],[4,9,'#888844'],[5,9,'#999944'],[6,9,'#aaaa55'],[7,9,'#bbbb66'],[8,9,'#aaaa55'],[9,9,'#888844'],
  [4,10,'#666633'],[5,10,'#777744'],[6,10,'#888844'],[7,10,'#777744'],[8,10,'#666633'],
  [2,8,'#555522'],[2,9,'#555522'],
  [8,7,'#111'],[8,8,'#fff'],
  [5,6,'#999944'],[6,6,'#aaaa55'],[6,5,'#888833'],
], 'none');

MB.SPRITES['trout'] = MB._px([
  [10,6,'#cc4466'],[11,6,'#dd5577'],
  [5,7,'#aa3355'],[6,7,'#cc5577'],[7,7,'#dd6688'],[8,7,'#ee7799'],[9,7,'#dd6688'],[10,7,'#cc5577'],
  [4,8,'#992244'],[5,8,'#bb4466'],[6,8,'#cc6688'],[7,8,'#dd88aa'],[8,8,'#eea0bb'],[9,8,'#dd7799'],[10,8,'#cc5577'],
  [4,9,'#882233'],[5,9,'#aa3355'],[6,9,'#bb5577'],[7,9,'#cc6688'],[8,9,'#bb5577'],[9,9,'#aa4466'],
  [5,10,'#771122'],[6,10,'#993344'],[7,10,'#aa4455'],[8,10,'#993344'],
  [3,8,'#882233'],[3,9,'#771122'],
  [9,7,'#111'],[9,8,'#fff'],
  [6,6,'#cc5577'],[7,6,'#dd6688'],[7,5,'#bb4466'],
  // spots
  [6,8,'#ff99bb'],[8,8,'#ff88aa'],
], 'none');

MB.SPRITES['eel'] = MB._px([
  [3,6,'#557733'],[4,6,'#669944'],[5,6,'#77aa55'],
  [3,7,'#446622'],[4,7,'#558833'],[5,7,'#77aa55'],[6,7,'#88bb66'],[7,7,'#77aa55'],[8,7,'#669944'],
  [4,8,'#446622'],[5,8,'#669944'],[6,8,'#88bb66'],[7,8,'#99cc77'],[8,8,'#88bb66'],[9,8,'#77aa55'],[10,8,'#558833'],
  [5,9,'#446622'],[6,9,'#669944'],[7,9,'#88bb66'],[8,9,'#99cc77'],[9,9,'#88bb66'],[10,9,'#77aa55'],[11,9,'#557733'],
  [7,10,'#446622'],[8,10,'#558833'],[9,10,'#669944'],[10,10,'#77aa55'],[11,10,'#669944'],[12,10,'#447722'],
  [6,7,'#111'],[6,8,'#ddeedd'],
], 'none');

MB.SPRITES['pike'] = MB._px([
  // Ghost pike — translucent white/blue
  [11,5,'#aabbcc'],[12,5,'#ccddee'],
  [5,6,'#8899aa'],[6,6,'#99aacc'],[7,6,'#aabbdd'],[8,6,'#bbccee'],[9,6,'#bbccee'],[10,6,'#aabbdd'],[11,6,'#99aabb'],
  [4,7,'#7788aa'],[5,7,'#8899bb'],[6,7,'#99aadd'],[7,7,'#aabbee'],[8,7,'#bbccff'],[9,7,'#aabbee'],[10,7,'#99aadd'],[11,7,'#8899bb'],
  [3,8,'#6677aa'],[4,8,'#7788bb'],[5,8,'#8899cc'],[6,8,'#99aadd'],[7,8,'#aabbee'],[8,8,'#99aadd'],[9,8,'#8899cc'],[10,8,'#7788bb'],
  [4,9,'#6677aa'],[5,9,'#7788bb'],[6,9,'#8899cc'],[7,9,'#99aadd'],[8,9,'#8899cc'],[9,9,'#7788bb'],
  [5,10,'#5566aa'],[6,10,'#6677bb'],[7,10,'#7788cc'],[8,10,'#6677bb'],
  [2,7,'#5566aa'],[2,8,'#4455aa'],
  [9,6,'#112233'],[9,7,'#eeeeff'],
], 'none');

MB.SPRITES['duck'] = MB._px([
  [6,3,'#ffdd22'],[7,3,'#ffee44'],[8,3,'#ffdd22'],
  [5,4,'#ffcc11'],[6,4,'#ffee44'],[7,4,'#ffffff'],[8,4,'#ffee44'],[9,4,'#ffcc11'],
  [5,5,'#eeaa00'],[6,5,'#ffcc22'],[7,5,'#ffee88'],[8,5,'#ffcc22'],[9,5,'#eeaa00'],
  [4,6,'#dd9900'],[5,6,'#ffbb11'],[6,6,'#ffdd44'],[7,6,'#ffcc22'],[8,6,'#ffbb11'],[9,6,'#dd9900'],[10,6,'#cc8800'],
  [4,7,'#cc8800'],[5,7,'#eeaa00'],[6,7,'#ffcc22'],[7,7,'#ffbb11'],[8,7,'#eeaa00'],[9,7,'#cc8800'],
  [5,8,'#bb7700'],[6,8,'#dd9900'],[7,8,'#dd9900'],[8,8,'#bb7700'],
  // eye + beak
  [8,4,'#111'],[8,5,'#fff'],
  [10,6,'#ff6600'],[11,6,'#ff7700'],
], 'none');

MB.SPRITES['bottle'] = MB._px([
  [7,2,'#aabbcc'],[8,2,'#bbccdd'],
  [6,3,'#8899aa'],[7,3,'#99aacc'],[8,3,'#aabbdd'],[9,3,'#99aabb'],
  [5,4,'#7788aa'],[6,4,'#8899bb'],[7,4,'#99aacc'],[8,4,'#8899bb'],[9,4,'#778899'],[10,4,'#667788'],
  [5,5,'#667799'],[6,5,'#7788aa'],[7,5,'#8899bb'],[8,5,'#7788aa'],[9,5,'#667799'],[10,5,'#556688'],
  [5,6,'#556699'],[6,6,'#6677aa'],[7,6,'#7788bb'],[8,6,'#6677aa'],[9,6,'#556699'],[10,6,'#445588'],
  [5,7,'#4455aa'],[6,7,'#5566bb'],[7,7,'#6677cc'],[8,7,'#5566bb'],[9,7,'#4455aa'],[10,7,'#334499'],
  [5,8,'#3344aa'],[6,8,'#4455bb'],[7,8,'#5566cc'],[8,8,'#4455bb'],[9,8,'#3344aa'],[10,8,'#223399'],
  [5,9,'#223388'],[6,9,'#3344aa'],[7,9,'#4455bb'],[8,9,'#3344aa'],[9,9,'#223388'],
  [6,10,'#112277'],[7,10,'#223388'],[8,10,'#112277'],
  // cork + label
  [7,2,'#cc9944'],[8,2,'#ddaa55'],
  [6,6,'#ffeecc'],[7,6,'#fff8dd'],[8,6,'#ffeecc'],
], 'none');

MB.SPRITES['boot'] = MB._px([
  [4,7,'#554433'],[5,7,'#665544'],[6,7,'#776655'],[7,7,'#665544'],
  [4,8,'#443322'],[5,8,'#665544'],[6,8,'#776655'],[7,8,'#887766'],[8,8,'#776655'],[9,8,'#665544'],
  [3,9,'#443322'],[4,9,'#554433'],[5,9,'#665544'],[6,9,'#776655'],[7,9,'#776655'],[8,9,'#887766'],[9,9,'#776655'],[10,9,'#665544'],
  [3,10,'#332211'],[4,10,'#443322'],[5,10,'#554433'],[6,10,'#665544'],[7,10,'#665544'],[8,10,'#776655'],[9,10,'#665544'],[10,10,'#554433'],[11,10,'#443322'],
  [3,11,'#221100'],[4,11,'#332211'],[5,11,'#443322'],[6,11,'#554433'],[7,11,'#554433'],[8,11,'#443322'],[9,11,'#332211'],
  // lace
  [6,7,'#ccc'],[7,7,'#bbb'],
  [6,8,'#aaa'],[8,8,'#aaa'],
], 'none');

// Myth creatures — more distinct sprites
MB.SPRITES['koi_ryu'] = MB._px([
  [8,2,'#ff6600'],[9,2,'#ff8822'],
  [6,3,'#ff4400'],[7,3,'#ff7711'],[8,3,'#ffaa33'],[9,3,'#ff8822'],[10,3,'#ff6600'],
  [5,4,'#dd3300'],[6,4,'#ff5511'],[7,4,'#ffaa44'],[8,4,'#ffcc66'],[9,4,'#ffaa44'],[10,4,'#ff7722'],[11,4,'#dd5500'],
  [4,5,'#cc2200'],[5,5,'#ee4411'],[6,5,'#ff8833'],[7,5,'#ffcc55'],[8,5,'#ffdd77'],[9,5,'#ffcc55'],[10,5,'#ff9933'],[11,5,'#ee6611'],
  [4,6,'#bb1100'],[5,6,'#dd3311'],[6,6,'#ff6622'],[7,6,'#ffaa44'],[8,6,'#ffcc66'],[9,6,'#ffaa44'],[10,6,'#ff7722'],[11,6,'#dd4400'],
  [5,7,'#cc2200'],[6,7,'#ee4411'],[7,7,'#ff7733'],[8,7,'#ffaa55'],[9,7,'#ff8833'],[10,7,'#ee5511'],
  [6,8,'#bb1100'],[7,8,'#dd3322'],[8,8,'#ff5533'],[9,8,'#dd3311'],
  [7,9,'#aa0000'],[8,9,'#cc2211'],
  [3,5,'#cc2200'],[3,6,'#aa0000'],
  [9,3,'#111'],[9,4,'#fff'],
  // whiskers
  [11,4,'#ffaa33'],[12,4,'#ffcc55'],[13,4,'#ffaa33'],
  [11,5,'#ff9922'],[12,5,'#ffbb44'],
], 'none');

MB.SPRITES['mythcarp'] = MB._px([
  // Iridescent mythic carp
  [8,3,'#cc44ff'],[9,3,'#dd66ff'],
  [6,4,'#aa22ee'],[7,4,'#cc44ff'],[8,4,'#ee66ff'],[9,4,'#ff88ff'],[10,4,'#dd66ff'],[11,4,'#aa22ee'],
  [5,5,'#8800cc'],[6,5,'#aa33ee'],[7,5,'#cc55ff'],[8,5,'#ee88ff'],[9,5,'#ffaaff'],[10,5,'#dd77ff'],[11,5,'#bb44ee'],
  [4,6,'#7700bb'],[5,6,'#9922dd'],[6,6,'#bb44ff'],[7,6,'#dd66ff'],[8,6,'#ffaaff'],[9,6,'#ee88ff'],[10,6,'#cc55ee'],[11,6,'#aa33cc'],
  [4,7,'#8811cc'],[5,7,'#aa33ee'],[6,7,'#cc55ff'],[7,7,'#ee77ff'],[8,7,'#dd66ee'],[9,7,'#bb44cc'],[10,7,'#9922aa'],
  [5,8,'#7700bb'],[6,8,'#9922cc'],[7,8,'#bb44ee'],[8,8,'#9922cc'],[9,8,'#7700aa'],
  [6,9,'#660099'],[7,9,'#8811bb'],[8,9,'#660088'],
  [3,6,'#660099'],[3,7,'#550088'],
  [9,4,'#111'],[9,5,'#fff'],
  [6,4,'#ffffaa'],[7,5,'#ffeeaa'],
], 'none');

MB.SPRITES['leviathan'] = MB._px([
  [3,4,'#1a3322'],[4,4,'#2a5533'],[5,4,'#3a7744'],
  [3,5,'#1a3322'],[4,5,'#3a6633'],[5,5,'#4a8844'],[6,5,'#5a9955'],[7,5,'#4a8844'],
  [3,6,'#224433'],[4,6,'#3a7744'],[5,6,'#4a9955'],[6,6,'#5aaa66'],[7,6,'#6abb77'],[8,6,'#5a9955'],[9,6,'#3a7744'],
  [3,7,'#1a3322'],[4,7,'#2a5533'],[5,7,'#3a7744'],[6,7,'#4a9955'],[7,7,'#5aaa66'],[8,7,'#4a8844'],[9,7,'#3a6633'],[10,7,'#2a4422'],
  [4,8,'#1a3322'],[5,8,'#2a5533'],[6,8,'#3a7744'],[7,8,'#4a8844'],[8,8,'#3a6633'],[9,8,'#2a5533'],[10,8,'#1a3322'],
  [5,9,'#1a3322'],[6,9,'#2a4422'],[7,9,'#3a6633'],[8,9,'#2a4422'],[9,9,'#1a3322'],
  [2,6,'#112211'],[2,7,'#112211'],
  [7,5,'#111'],[7,6,'#aaffcc'],
  // scales
  [5,6,'#6acc77'],[7,7,'#55aa66'],
], 'none');

MB.SPRITES['qallu'] = MB._px([
  // Inuit ice spirit — pale blue crystalline
  [7,3,'#ddeeff'],[8,3,'#eef8ff'],
  [6,4,'#bbddff'],[7,4,'#ddeeff'],[8,4,'#eef8ff'],[9,4,'#cceeee'],
  [5,5,'#99ccff'],[6,5,'#bbddff'],[7,5,'#ddeeff'],[8,5,'#eef8ff'],[9,5,'#bbddee'],[10,5,'#99bbcc'],
  [4,6,'#88bbee'],[5,6,'#aaccff'],[6,6,'#ccddff'],[7,6,'#ddeeff'],[8,6,'#cceeff'],[9,6,'#aaccdd'],[10,6,'#88aacc'],
  [4,7,'#77aadd'],[5,7,'#99bbee'],[6,7,'#bbccff'],[7,7,'#ccddff'],[8,7,'#bbccee'],[9,7,'#99aacc'],[10,7,'#7799bb'],
  [5,8,'#6699cc'],[6,8,'#88aadd'],[7,8,'#aabbee'],[8,8,'#99aadd'],[9,8,'#7799cc'],
  [6,9,'#5588bb'],[7,9,'#7799cc'],[8,9,'#5577bb'],
  [3,6,'#6699cc'],[3,7,'#5588bb'],
  [8,4,'#111'],[8,5,'#fff'],
  // ice crystals
  [5,4,'#ffffff'],[10,6,'#ffffff'],[6,8,'#eef8ff'],
], 'none');

// Mythic rare fish
MB.SPRITES['afanc'] = MB._px([
  [5,4,'#226644'],[6,4,'#338855'],[7,4,'#44aa66'],[8,4,'#338855'],
  [4,5,'#115533'],[5,5,'#337755'],[6,5,'#44aa77'],[7,5,'#55bb88'],[8,5,'#44aa77'],[9,5,'#338855'],[10,5,'#226644'],
  [3,6,'#115533'],[4,6,'#226644'],[5,6,'#337755'],[6,6,'#44aa77'],[7,6,'#55bb88'],[8,6,'#44aa77'],[9,6,'#337755'],[10,6,'#226644'],
  [3,7,'#115533'],[4,7,'#226644'],[5,7,'#338855'],[6,7,'#44aa77'],[7,7,'#55bb88'],[8,7,'#44aa77'],[9,7,'#337755'],[10,7,'#115533'],
  [4,8,'#115533'],[5,8,'#226644'],[6,8,'#337755'],[7,8,'#44aa66'],[8,8,'#337755'],[9,8,'#226644'],
  [5,9,'#115533'],[6,9,'#226644'],[7,9,'#226644'],[8,9,'#115533'],
  [7,5,'#111'],[7,6,'#88ffaa'],
  [2,6,'#0a3322'],[2,7,'#0a3322'],
], 'none');

MB.SPRITES['kelpie'] = MB._px([
  // Water horse
  [8,2,'#336688'],[9,2,'#4488aa'],
  [6,3,'#224477'],[7,3,'#336699'],[8,3,'#4488bb'],[9,3,'#3377aa'],[10,3,'#225588'],
  [5,4,'#112266'],[6,4,'#224488'],[7,4,'#3366aa'],[8,4,'#4488cc'],[9,4,'#3377aa'],[10,4,'#224488'],[11,4,'#112266'],
  [5,5,'#112266'],[6,5,'#2255aa'],[7,5,'#3377cc'],[8,5,'#4499dd'],[9,5,'#3388cc'],[10,5,'#2266aa'],[11,5,'#112277'],
  [4,6,'#0a1155'],[5,6,'#112277'],[6,6,'#2266aa'],[7,6,'#3388cc'],[8,6,'#44aadd'],[9,6,'#3399cc'],[10,6,'#226699'],[11,6,'#113366'],
  [4,7,'#0a1144'],[5,7,'#112266'],[6,7,'#2255aa'],[7,7,'#3377bb'],[8,7,'#3388cc'],[9,7,'#2266aa'],[10,7,'#113377'],
  [5,8,'#112266'],[6,8,'#2255aa'],[7,8,'#3366bb'],[8,8,'#2255aa'],[9,8,'#112266'],
  [3,5,'#0a1155'],[3,6,'#0a1144'],
  [8,3,'#111'],[8,4,'#aaccff'],
  // mane
  [7,3,'#55aacc'],[8,3,'#77ccee'],[9,3,'#55aacc'],
], 'none');

MB.SPRITES['aspido'] = MB._px([
  // Giant turtle
  [5,4,'#446633'],[6,4,'#557744'],[7,4,'#668855'],[8,4,'#557744'],[9,4,'#446633'],
  [4,5,'#335522'],[5,5,'#558844'],[6,5,'#77aa66'],[7,5,'#88bb77'],[8,5,'#77aa66'],[9,5,'#558844'],[10,5,'#335522'],
  [3,6,'#335522'],[4,6,'#4a7733'],[5,6,'#669955'],[6,6,'#88bb66'],[7,6,'#99cc77'],[8,6,'#88bb66'],[9,6,'#669955'],[10,6,'#4a7733'],[11,6,'#335522'],
  [3,7,'#3a6633'],[4,7,'#558844'],[5,7,'#779966'],[6,7,'#88bb77'],[7,7,'#99cc88'],[8,7,'#88bb77'],[9,7,'#779966'],[10,7,'#558844'],[11,7,'#3a6633'],
  [4,8,'#446633'],[5,8,'#668855'],[6,8,'#779966'],[7,8,'#88aa77'],[8,8,'#779966'],[9,8,'#668855'],[10,8,'#446633'],
  [5,9,'#335522'],[6,9,'#4a7733'],[7,9,'#558844'],[8,9,'#4a7733'],[9,9,'#335522'],
  // head
  [11,6,'#557744'],[12,6,'#669955'],[12,7,'#557744'],
  [12,6,'#111'],[12,7,'#aaffaa'],
  // shell pattern
  [6,6,'#335522'],[7,6,'#335522'],[8,6,'#335522'],
  [6,7,'#3a6633'],[8,7,'#3a6633'],
], 'none');

MB.SPRITES['tiddalik'] = MB._px([
  // Large frog
  [5,3,'#44bb44'],[6,3,'#55cc55'],[7,3,'#66dd66'],[8,3,'#55cc55'],[9,3,'#44bb44'],
  [4,4,'#33aa33'],[5,4,'#55cc55'],[6,4,'#77ee77'],[7,4,'#88ff88'],[8,4,'#77ee77'],[9,4,'#55cc55'],[10,4,'#33aa33'],
  [3,5,'#228822'],[4,5,'#44bb44'],[5,5,'#66dd66'],[6,5,'#88ff88'],[7,5,'#99ff99'],[8,5,'#77ee77'],[9,5,'#55cc55'],[10,5,'#44bb44'],[11,5,'#228822'],
  [3,6,'#228822'],[4,6,'#44bb44'],[5,6,'#55cc55'],[6,6,'#77dd77'],[7,6,'#88ee88'],[8,6,'#77dd77'],[9,6,'#55cc55'],[10,6,'#44bb44'],[11,6,'#228822'],
  [3,7,'#117711'],[4,7,'#33aa33'],[5,7,'#44bb44'],[6,7,'#55cc55'],[7,7,'#66dd66'],[8,7,'#55cc55'],[9,7,'#44bb44'],[10,7,'#33aa33'],[11,7,'#117711'],
  [4,8,'#228822'],[5,8,'#33aa33'],[6,8,'#44bb44'],[7,8,'#44bb44'],[8,8,'#33aa33'],[9,8,'#228822'],
  [5,9,'#117711'],[6,9,'#228822'],[7,9,'#228822'],[8,9,'#117711'],
  // eyes
  [5,4,'#111'],[5,5,'#fff'],[9,4,'#111'],[9,5,'#fff'],
  // belly
  [6,6,'#aaffaa'],[7,6,'#bbffbb'],[8,6,'#aaffaa'],
], 'none');

MB.SPRITES['ahuizotl'] = MB._px([
  // Aztec river spirit — otter-like
  [6,3,'#774422'],[7,3,'#996633'],[8,3,'#774422'],
  [5,4,'#663311'],[6,4,'#885533'],[7,4,'#aa7755'],[8,4,'#996644'],[9,4,'#774433'],
  [4,5,'#552200'],[5,5,'#774433'],[6,5,'#996655'],[7,5,'#bb8877'],[8,5,'#996655'],[9,5,'#774433'],[10,5,'#552200'],
  [4,6,'#663311'],[5,6,'#885533'],[6,6,'#aa7755'],[7,6,'#cc9977'],[8,6,'#aa7755'],[9,6,'#885533'],[10,6,'#552200'],
  [4,7,'#552200'],[5,7,'#774433'],[6,7,'#996655'],[7,7,'#aa7766'],[8,7,'#886644'],[9,7,'#663322'],
  [5,8,'#441100'],[6,8,'#663311'],[7,8,'#885533'],[8,8,'#663311'],
  [3,5,'#441100'],[3,6,'#330000'],
  [8,4,'#111'],[8,5,'#fff'],
  // tail hand
  [11,5,'#774422'],[12,5,'#885533'],[12,6,'#774422'],
], 'none');

// Consumables
MB.SPRITES['potion'] = MB._px([
  [7,2,'#cc3344'],[8,2,'#dd4455'],
  [6,3,'#aa2233'],[7,3,'#cc4455'],[8,3,'#dd5566'],[9,3,'#bb3344'],
  [5,4,'#7788aa'],[6,4,'#99aacc'],[7,4,'#dd5566'],[8,4,'#ee6677'],[9,4,'#8899bb'],[10,4,'#667799'],
  [5,5,'#6677aa'],[6,5,'#8899cc'],[7,5,'#ee7788'],[8,5,'#ff8899'],[9,5,'#7788bb'],[10,5,'#5566aa'],
  [4,6,'#5566aa'],[5,6,'#7788cc'],[6,6,'#cc4455'],[7,6,'#ee6677'],[8,6,'#dd5566'],[9,6,'#6677bb'],[10,6,'#4455aa'],[11,6,'#3344aa'],
  [4,7,'#4455aa'],[5,7,'#6677cc'],[6,7,'#bb3344'],[7,7,'#dd5566'],[8,7,'#cc4455'],[9,7,'#5566bb'],[10,7,'#3344aa'],[11,7,'#2233aa'],
  [5,8,'#3344aa'],[6,8,'#5566cc'],[7,8,'#9922aa'],[8,8,'#aa3344'],[9,8,'#4455bb'],[10,8,'#3344aa'],
  [5,9,'#2233aa'],[6,9,'#3344bb'],[7,9,'#4455cc'],[8,9,'#3344bb'],[9,9,'#2233aa'],
  [6,10,'#1122aa'],[7,10,'#2233bb'],[8,10,'#1122aa'],
], 'none');

MB.SPRITES['ether'] = MB._px([
  [7,2,'#4488cc'],[8,2,'#55aaee'],
  [6,3,'#3377bb'],[7,3,'#5599dd'],[8,3,'#66aaee'],[9,3,'#4488cc'],
  [5,4,'#6677aa'],[6,4,'#7799cc'],[7,4,'#66aaee'],[8,4,'#77bbff'],[9,4,'#6699cc'],[10,4,'#5577bb'],
  [5,5,'#5566aa'],[6,5,'#6688cc'],[7,5,'#77aaee'],[8,5,'#88bbff'],[9,5,'#5588cc'],[10,5,'#4466bb'],
  [4,6,'#4455aa'],[5,6,'#5577cc'],[6,6,'#3399ee'],[7,6,'#55aaff'],[8,6,'#44aabb'],[9,6,'#4477cc'],[10,6,'#3355bb'],[11,6,'#2244aa'],
  [4,7,'#3344aa'],[5,7,'#4466cc'],[6,7,'#2288dd'],[7,7,'#44aaee'],[8,7,'#3399cc'],[9,7,'#3366cc'],[10,7,'#2244bb'],[11,7,'#1133aa'],
  [5,8,'#2233aa'],[6,8,'#3355cc'],[7,8,'#2277dd'],[8,8,'#2288cc'],[9,8,'#2255cc'],[10,8,'#1133bb'],
  [5,9,'#1122aa'],[6,9,'#2244cc'],[7,9,'#3355cc'],[8,9,'#2244cc'],[9,9,'#1133aa'],
  [6,10,'#0011aa'],[7,10,'#1133bb'],[8,10,'#0011aa'],
], 'none');

MB.SPRITES['elixir'] = MB._px([
  [7,2,'#ffaa00'],[8,2,'#ffcc22'],
  [6,3,'#dd8800'],[7,3,'#ffbb11'],[8,3,'#ffdd33'],[9,3,'#dd9900'],
  [5,4,'#887799'],[6,4,'#aa99cc'],[7,4,'#ffcc22'],[8,4,'#ffdd44'],[9,4,'#9988bb'],[10,4,'#7766aa'],
  [5,5,'#776688'],[6,5,'#9988bb'],[7,5,'#ffcc22'],[8,5,'#ffee55'],[9,5,'#8877aa'],[10,5,'#665599'],
  [4,6,'#665588'],[5,6,'#8877aa'],[6,6,'#ddaa00'],[7,6,'#ffcc22'],[8,6,'#ffdd44'],[9,6,'#7766aa'],[10,6,'#554488'],[11,6,'#443377'],
  [4,7,'#554477'],[5,7,'#7766aa'],[6,7,'#cc9900'],[7,7,'#ffbb11'],[8,7,'#ffcc33'],[9,7,'#6655aa'],[10,7,'#443388'],[11,7,'#332277'],
  [5,8,'#443377'],[6,8,'#665599'],[7,8,'#886600'],[8,8,'#ddaa00'],[9,8,'#5544aa'],[10,8,'#332277'],
  [5,9,'#332266'],[6,9,'#554488'],[7,9,'#7755aa'],[8,9,'#6644aa'],[9,9,'#331177'],
  [6,10,'#221166'],[7,10,'#443388'],[8,10,'#221155'],
], 'none');

MB.SPRITES['antidote'] = MB._px([
  [7,2,'#44dd44'],[8,2,'#55ee55'],
  [6,3,'#33bb33'],[7,3,'#44dd44'],[8,3,'#55ee55'],[9,3,'#33cc33'],
  [5,4,'#667788'],[6,4,'#8899aa'],[7,4,'#44cc44'],[8,4,'#55dd55'],[9,4,'#7788aa'],[10,4,'#5566aa'],
  [5,5,'#556677'],[6,5,'#778899'],[7,5,'#33bb33'],[8,5,'#44cc44'],[9,5,'#6677aa'],[10,5,'#4455aa'],
  [4,6,'#445566'],[5,6,'#667799'],[6,6,'#22aa22'],[7,6,'#33bb33'],[8,6,'#33aa33'],[9,6,'#5566aa'],[10,6,'#334499'],[11,6,'#223388'],
  [4,7,'#334455'],[5,7,'#556688'],[6,7,'#119911'],[7,7,'#22aa22'],[8,7,'#22aa22'],[9,7,'#4455aa'],[10,7,'#223388'],[11,7,'#112277'],
  [5,8,'#223344'],[6,8,'#445577'],[7,8,'#117711'],[8,8,'#119911'],[9,8,'#3344aa'],[10,8,'#112277'],
  [5,9,'#112233'],[6,9,'#334466'],[7,9,'#336655'],[8,9,'#224455'],[9,9,'#112266'],
  [6,10,'#001122'],[7,10,'#223344'],[8,10,'#001122'],
], 'none');

MB.SPRITES['bomb'] = MB._px([
  [6,2,'#888'],[7,2,'#aaa'],[8,2,'#999'],
  [6,3,'#ff8800'],[7,3,'#ffaa22'],[8,3,'#ff9900'],
  [5,4,'#333'],[6,4,'#555'],[7,4,'#666'],[8,4,'#555'],[9,4,'#333'],
  [4,5,'#222'],[5,5,'#555'],[6,5,'#777'],[7,5,'#888'],[8,5,'#777'],[9,5,'#555'],[10,5,'#222'],
  [4,6,'#222'],[5,6,'#444'],[6,6,'#666'],[7,6,'#777'],[8,6,'#666'],[9,6,'#555'],[10,6,'#222'],
  [4,7,'#333'],[5,7,'#555'],[6,7,'#666'],[7,7,'#777'],[8,7,'#666'],[9,7,'#555'],[10,7,'#333'],
  [5,8,'#333'],[6,8,'#444'],[7,8,'#555'],[8,8,'#444'],[9,8,'#333'],
  [6,9,'#222'],[7,9,'#333'],[8,9,'#222'],
  // highlight
  [6,5,'#999'],[7,5,'#aaa'],
], 'none');

// Materials
MB.SPRITES['root_fiber'] = MB._px([
  [4,5,'#886633'],[5,5,'#aa8844'],[6,5,'#996633'],
  [3,6,'#775522'],[4,6,'#996644'],[5,6,'#bb8855'],[6,6,'#aa7744'],[7,6,'#886633'],[8,6,'#775522'],
  [3,7,'#664411'],[4,7,'#885533'],[5,7,'#aa7744'],[6,7,'#cc9966'],[7,7,'#bb8855'],[8,7,'#996644'],[9,7,'#775522'],
  [4,8,'#553300'],[5,8,'#774422'],[6,8,'#996644'],[7,8,'#aa7755'],[8,8,'#886633'],[9,8,'#664411'],[10,8,'#553300'],
  [5,9,'#442200'],[6,9,'#664422'],[7,9,'#885533'],[8,9,'#775522'],[9,9,'#553311'],
  [6,10,'#331100'],[7,10,'#553322'],[8,10,'#442211'],
], 'none');

MB.SPRITES['ancient_sap'] = MB._px([
  [6,3,'#cc8800'],[7,3,'#ddaa22'],[8,3,'#cc9900'],
  [5,4,'#bb7700'],[6,4,'#ddaa33'],[7,4,'#ffcc44'],[8,4,'#ddaa33'],[9,4,'#bb8800'],
  [5,5,'#aa6600'],[6,5,'#cc9922'],[7,5,'#eebb33'],[8,5,'#cc9922'],[9,5,'#aa7700'],
  [5,6,'#996600'],[6,6,'#bb8811'],[7,6,'#ddaa33'],[8,6,'#bb8811'],[9,6,'#996600'],
  [6,7,'#884400'],[7,7,'#aa6611'],[8,7,'#cc8822'],[9,7,'#aa6600'],
  [7,8,'#773300'],[8,8,'#995511'],[9,8,'#773300'],
  [8,9,'#552200'],[9,9,'#662200'],
  // glow
  [6,4,'#fff0aa'],[7,4,'#fffacc'],[7,5,'#fff0bb'],
], 'none');

MB.SPRITES['shadow_gem'] = MB._px([
  [7,3,'#8833aa'],[8,3,'#aa44cc'],
  [6,4,'#6622aa'],[7,4,'#9944cc'],[8,4,'#bb55ee'],[9,4,'#8833bb'],
  [5,5,'#5511aa'],[6,5,'#7733cc'],[7,5,'#9955ee'],[8,5,'#aa44dd'],[9,5,'#8833cc'],[10,5,'#6611aa'],
  [5,6,'#6622aa'],[6,6,'#8844cc'],[7,6,'#aA55ee'],[8,6,'#cc66ff'],[9,6,'#aa44dd'],[10,6,'#7722bb'],
  [5,7,'#5511aa'],[6,7,'#7733cc'],[7,7,'#9944dd'],[8,7,'#bb55ee'],[9,7,'#8833cc'],[10,7,'#5511aa'],
  [6,8,'#4400aa'],[7,8,'#6622cc'],[8,8,'#7733cc'],[9,8,'#5511aa'],
  [7,9,'#330099'],[8,9,'#4411aa'],
  // inner light
  [7,5,'#ddbbff'],[8,6,'#ffffff'],[7,6,'#eeccff'],
], 'none');

// Key items
MB.SPRITES['deeproot_key'] = MB._px([
  [8,2,'#aa8833'],[9,2,'#ccaa44'],
  [7,3,'#cc9933'],[8,3,'#ffcc44'],[9,3,'#ddaa33'],[10,3,'#cc9933'],
  [6,4,'#bb8822'],[7,4,'#ddaa33'],[8,4,'#ffdd55'],[9,4,'#ddaa33'],[10,4,'#aa7722'],
  [7,5,'#cc9933'],[8,5,'#eebb44'],[9,5,'#cc9933'],
  [8,6,'#bb8822'],[8,7,'#aa7711'],[8,8,'#bb8822'],
  [8,9,'#cc9933'],[8,10,'#bb8822'],[8,11,'#cc9933'],
  [7,10,'#aa7711'],[9,10,'#aa7711'],
  [7,11,'#bb8822'],[9,11,'#bb8822'],
], 'none');

MB.SPRITES['myth_heart'] = MB._px([
  // Pulsing mythic heart — deep purple/gold
  [5,4,'#8833cc'],[6,4,'#aa44ee'],[8,4,'#aa44ee'],[9,4,'#8833cc'],
  [4,5,'#7722bb'],[5,5,'#aa55ee'],[6,5,'#cc77ff'],[7,5,'#dd88ff'],[8,5,'#cc77ff'],[9,5,'#aa44ee'],[10,5,'#7722bb'],
  [4,6,'#8833cc'],[5,6,'#bb66ff'],[6,6,'#dd99ff'],[7,6,'#eeb0ff'],[8,6,'#dd99ff'],[9,6,'#bb66ff'],[10,6,'#8833cc'],
  [4,7,'#7722bb'],[5,7,'#aa55ee'],[6,7,'#cc88ff'],[7,7,'#ddaaff'],[8,7,'#cc88ff'],[9,7,'#aa55ee'],[10,7,'#7722bb'],
  [5,8,'#6611aa'],[6,8,'#9944dd'],[7,8,'#bb77ff'],[8,8,'#9944dd'],[9,8,'#6611aa'],
  [6,9,'#550099'],[7,9,'#7733cc'],[8,9,'#550099'],
  [7,10,'#440088'],
  // gold glow
  [6,5,'#fff8aa'],[7,5,'#ffffcc'],[8,5,'#fff8aa'],
  [6,6,'#ffeeaa'],[7,6,'#fffff0'],[8,6,'#ffeeaa'],
], 'none');

MB.SPRITES['phoenix_binding'] = MB._px([
  // Flame with mythic aura
  [7,2,'#ff4400'],[8,2,'#ff6600'],
  [6,3,'#ff3300'],[7,3,'#ff6600'],[8,3,'#ff8800'],[9,3,'#ff4400'],
  [5,4,'#ff2200'],[6,4,'#ff5500'],[7,4,'#ffaa00'],[8,4,'#ffcc22'],[9,4,'#ff6600'],[10,4,'#ff2200'],
  [4,5,'#ee1100'],[5,5,'#ff4400'],[6,5,'#ff8800'],[7,5,'#ffdd44'],[8,5,'#ffee66'],[9,5,'#ff7700'],[10,5,'#ee2200'],
  [4,6,'#cc0000'],[5,6,'#ff3300'],[6,6,'#ff6600'],[7,6,'#ffcc33'],[8,6,'#ffdd55'],[9,6,'#ff5500'],[10,6,'#dd1100'],
  [5,7,'#bb0000'],[6,7,'#ee3300'],[7,7,'#ff8811'],[8,7,'#ffaa22'],[9,7,'#ee4400'],[10,7,'#cc0000'],
  [6,8,'#990000'],[7,8,'#cc4400'],[8,8,'#ee7711'],[9,8,'#cc2200'],
  [7,9,'#880000'],[8,9,'#aa3300'],
  [7,10,'#660000'],
  // purple aura
  [5,4,'#cc44ff'],[4,5,'#aa22ee'],[4,6,'#aa22ee'],
  [10,5,'#cc44ff'],[11,5,'#aa22ee'],[10,6,'#aa22ee'],
], 'none');

// Equipment
MB.SPRITES['iron_crown'] = MB._px([
  [4,4,'#888'],[7,4,'#888'],[10,4,'#888'],
  [4,5,'#888'],[5,5,'#999'],[6,5,'#aaa'],[7,5,'#999'],[8,5,'#aaa'],[9,5,'#999'],[10,5,'#888'],
  [4,6,'#777'],[5,6,'#888'],[6,6,'#999'],[7,6,'#aaa'],[8,6,'#999'],[9,6,'#888'],[10,6,'#777'],[11,6,'#666'],
  [3,7,'#666'],[4,7,'#777'],[5,7,'#888'],[6,7,'#999'],[7,7,'#aaa'],[8,7,'#999'],[9,7,'#888'],[10,7,'#777'],[11,7,'#666'],
  [3,8,'#555'],[4,8,'#666'],[5,8,'#777'],[6,8,'#888'],[7,8,'#888'],[8,8,'#888'],[9,8,'#777'],[10,8,'#666'],[11,8,'#555'],
  [4,9,'#555'],[5,9,'#666'],[6,9,'#777'],[7,9,'#777'],[8,9,'#777'],[9,9,'#666'],[10,9,'#555'],
  [5,10,'#444'],[6,10,'#555'],[7,10,'#555'],[8,10,'#555'],[9,10,'#444'],
  // gems
  [7,4,'#6bb5ff'],[10,4,'#c455e8'],[4,4,'#ffdd6b'],
], 'none');

MB.SPRITES['void_blade'] = MB._px([
  [8,2,'#8833cc'],[8,3,'#aa44ee'],
  [7,3,'#7722bb'],[8,4,'#9933dd'],[9,3,'#7722bb'],
  [7,4,'#6611aa'],[8,5,'#8822cc'],[9,4,'#6611aa'],
  [6,5,'#5500aa'],[7,5,'#7711bb'],[8,6,'#7722cc'],[9,5,'#5500aa'],
  [6,6,'#440099'],[7,6,'#6611aa'],[8,7,'#6611bb'],[9,6,'#440099'],
  [5,7,'#330088'],[6,7,'#5500aa'],[7,7,'#5500aa'],[8,8,'#5500aa'],[9,7,'#330088'],
  [5,8,'#220077'],[6,8,'#440099'],[7,8,'#440099'],[9,8,'#220077'],
  [5,9,'#110066'],[6,9,'#330088'],[7,9,'#330088'],[8,9,'#330077'],
  [6,10,'#220077'],[7,10,'#220066'],
  [7,11,'#110055'],
  // handle
  [4,8,'#aa7733'],[4,9,'#bb8844'],[4,10,'#aa7733'],
  [3,9,'#cc9944'],[5,9,'#cc9944'],
  // void glow
  [8,4,'#dd99ff'],[7,5,'#cc88ff'],
], 'none');

// Add remaining item sprites as aliases or simplified versions
MB.SPRITES['ashen_vest']      = MB.SPRITES['iron_crown']; // placeholder — vest shape TODO
MB.SPRITES['iron_shield']     = MB.SPRITES['rubble'];     // placeholder TODO
MB.SPRITES['silver_ring']     = MB.SPRITES['geode'];      // placeholder TODO  
MB.SPRITES['ember_boots']     = MB.SPRITES['boot'];
MB.SPRITES['sage_legs']       = MB.SPRITES['root_fiber'];  // placeholder TODO
MB.SPRITES['crystal_trinket'] = MB.SPRITES['shadow_gem'];

MB.SPRITES['myth_heart_phoenix'] = MB._px([[4,4,'#ff6600'],[5,4,'#ff6600'],[7,4,'#ff6600'],[8,4,'#ff6600'],[3,5,'#ff6600'],[4,5,'#ffaa44'],[5,5,'#ffaa44'],[6,5,'#ff6600'],[7,5,'#ff6600'],[8,5,'#ff6600'],[9,5,'#ff6600'],[3,6,'#ff6600'],[4,6,'#ff6600'],[5,6,'#ff6600'],[6,6,'#ff6600'],[7,6,'#ff6600'],[8,6,'#ff6600'],[9,6,'#ff6600'],[4,7,'#ff6600'],[5,7,'#ff6600'],[6,7,'#ff6600'],[7,7,'#ff6600'],[8,7,'#ff6600'],[5,8,'#ff6600'],[6,8,'#ff6600'],[7,8,'#ff6600'],[6,9,'#ff6600'],[5,3,'#ff8800'],[7,3,'#ff8800'],[3,7,'#ff8800'],[9,7,'#ff8800']],'none');
MB.SPRITES['myth_heart_leviathan'] = MB._px([[4,4,'#0055cc'],[5,4,'#0055cc'],[7,4,'#0055cc'],[8,4,'#0055cc'],[3,5,'#0055cc'],[4,5,'#4499ff'],[5,5,'#4499ff'],[6,5,'#0055cc'],[7,5,'#0055cc'],[8,5,'#0055cc'],[9,5,'#0055cc'],[3,6,'#0055cc'],[4,6,'#0055cc'],[5,6,'#0055cc'],[6,6,'#0055cc'],[7,6,'#0055cc'],[8,6,'#0055cc'],[9,6,'#0055cc'],[4,7,'#0055cc'],[5,7,'#0055cc'],[6,7,'#0055cc'],[7,7,'#0055cc'],[8,7,'#0055cc'],[5,8,'#0055cc'],[6,8,'#0055cc'],[7,8,'#0055cc'],[6,9,'#0055cc'],[5,3,'#0088ff'],[7,3,'#0088ff'],[3,7,'#0088ff'],[9,7,'#0088ff']],'none');
MB.SPRITES['myth_heart_thunderoc'] = MB._px([[4,4,'#ccaa00'],[5,4,'#ccaa00'],[7,4,'#ccaa00'],[8,4,'#ccaa00'],[3,5,'#ccaa00'],[4,5,'#ffee44'],[5,5,'#ffee44'],[6,5,'#ccaa00'],[7,5,'#ccaa00'],[8,5,'#ccaa00'],[9,5,'#ccaa00'],[3,6,'#ccaa00'],[4,6,'#ccaa00'],[5,6,'#ccaa00'],[6,6,'#ccaa00'],[7,6,'#ccaa00'],[8,6,'#ccaa00'],[9,6,'#ccaa00'],[4,7,'#ccaa00'],[5,7,'#ccaa00'],[6,7,'#ccaa00'],[7,7,'#ccaa00'],[8,7,'#ccaa00'],[5,8,'#ccaa00'],[6,8,'#ccaa00'],[7,8,'#ccaa00'],[6,9,'#ccaa00'],[5,3,'#ffdd00'],[7,3,'#ffdd00'],[3,7,'#ffdd00'],[9,7,'#ffdd00']],'none');
MB.SPRITES['myth_heart_voidwyrm'] = MB._px([[4,4,'#7700cc'],[5,4,'#7700cc'],[7,4,'#7700cc'],[8,4,'#7700cc'],[3,5,'#7700cc'],[4,5,'#bb44ff'],[5,5,'#bb44ff'],[6,5,'#7700cc'],[7,5,'#7700cc'],[8,5,'#7700cc'],[9,5,'#7700cc'],[3,6,'#7700cc'],[4,6,'#7700cc'],[5,6,'#7700cc'],[6,6,'#7700cc'],[7,6,'#7700cc'],[8,6,'#7700cc'],[9,6,'#7700cc'],[4,7,'#7700cc'],[5,7,'#7700cc'],[6,7,'#7700cc'],[7,7,'#7700cc'],[8,7,'#7700cc'],[5,8,'#7700cc'],[6,8,'#7700cc'],[7,8,'#7700cc'],[6,9,'#7700cc'],[5,3,'#aa00ff'],[7,3,'#aa00ff'],[3,7,'#aa00ff'],[9,7,'#aa00ff']],'none');
MB.SPRITES['myth_heart_solarveil'] = MB._px([[4,4,'#cccccc'],[5,4,'#cccccc'],[7,4,'#cccccc'],[8,4,'#cccccc'],[3,5,'#cccccc'],[4,5,'#ffffff'],[5,5,'#ffffff'],[6,5,'#cccccc'],[7,5,'#cccccc'],[8,5,'#cccccc'],[9,5,'#cccccc'],[3,6,'#cccccc'],[4,6,'#cccccc'],[5,6,'#cccccc'],[6,6,'#cccccc'],[7,6,'#cccccc'],[8,6,'#cccccc'],[9,6,'#cccccc'],[4,7,'#cccccc'],[5,7,'#cccccc'],[6,7,'#cccccc'],[7,7,'#cccccc'],[8,7,'#cccccc'],[5,8,'#cccccc'],[6,8,'#cccccc'],[7,8,'#cccccc'],[6,9,'#cccccc'],[5,3,'#ffffee'],[7,3,'#ffffee'],[3,7,'#ffffee'],[9,7,'#ffffee']],'none');
MB.SPRITES['myth_heart_emberbear'] = MB._px([[4,4,'#cc3300'],[5,4,'#cc3300'],[7,4,'#cc3300'],[8,4,'#cc3300'],[3,5,'#cc3300'],[4,5,'#ff7744'],[5,5,'#ff7744'],[6,5,'#cc3300'],[7,5,'#cc3300'],[8,5,'#cc3300'],[9,5,'#cc3300'],[3,6,'#cc3300'],[4,6,'#cc3300'],[5,6,'#cc3300'],[6,6,'#cc3300'],[7,6,'#cc3300'],[8,6,'#cc3300'],[9,6,'#cc3300'],[4,7,'#cc3300'],[5,7,'#cc3300'],[6,7,'#cc3300'],[7,7,'#cc3300'],[8,7,'#cc3300'],[5,8,'#cc3300'],[6,8,'#cc3300'],[7,8,'#cc3300'],[6,9,'#cc3300'],[5,3,'#ff4400'],[7,3,'#ff4400'],[3,7,'#ff4400'],[9,7,'#ff4400']],'none');
MB.SPRITES['myth_heart_moonshade'] = MB._px([[4,4,'#7777cc'],[5,4,'#7777cc'],[7,4,'#7777cc'],[8,4,'#7777cc'],[3,5,'#7777cc'],[4,5,'#aaaaff'],[5,5,'#aaaaff'],[6,5,'#7777cc'],[7,5,'#7777cc'],[8,5,'#7777cc'],[9,5,'#7777cc'],[3,6,'#7777cc'],[4,6,'#7777cc'],[5,6,'#7777cc'],[6,6,'#7777cc'],[7,6,'#7777cc'],[8,6,'#7777cc'],[9,6,'#7777cc'],[4,7,'#7777cc'],[5,7,'#7777cc'],[6,7,'#7777cc'],[7,7,'#7777cc'],[8,7,'#7777cc'],[5,8,'#7777cc'],[6,8,'#7777cc'],[7,8,'#7777cc'],[6,9,'#7777cc'],[5,3,'#9999ee'],[7,3,'#9999ee'],[3,7,'#9999ee'],[9,7,'#9999ee']],'none');
MB.SPRITES['myth_heart_stoneheart'] = MB._px([[4,4,'#555555'],[5,4,'#555555'],[7,4,'#555555'],[8,4,'#555555'],[3,5,'#555555'],[4,5,'#999999'],[5,5,'#999999'],[6,5,'#555555'],[7,5,'#555555'],[8,5,'#555555'],[9,5,'#555555'],[3,6,'#555555'],[4,6,'#555555'],[5,6,'#555555'],[6,6,'#555555'],[7,6,'#555555'],[8,6,'#555555'],[9,6,'#555555'],[4,7,'#555555'],[5,7,'#555555'],[6,7,'#555555'],[7,7,'#555555'],[8,7,'#555555'],[5,8,'#555555'],[6,8,'#555555'],[7,8,'#555555'],[6,9,'#555555'],[5,3,'#777777'],[7,3,'#777777'],[3,7,'#777777'],[9,7,'#777777']],'none');
MB.SPRITES['myth_heart_tidecaller'] = MB._px([[4,4,'#0099bb'],[5,4,'#0099bb'],[7,4,'#0099bb'],[8,4,'#0099bb'],[3,5,'#0099bb'],[4,5,'#44ddff'],[5,5,'#44ddff'],[6,5,'#0099bb'],[7,5,'#0099bb'],[8,5,'#0099bb'],[9,5,'#0099bb'],[3,6,'#0099bb'],[4,6,'#0099bb'],[5,6,'#0099bb'],[6,6,'#0099bb'],[7,6,'#0099bb'],[8,6,'#0099bb'],[9,6,'#0099bb'],[4,7,'#0099bb'],[5,7,'#0099bb'],[6,7,'#0099bb'],[7,7,'#0099bb'],[8,7,'#0099bb'],[5,8,'#0099bb'],[6,8,'#0099bb'],[7,8,'#0099bb'],[6,9,'#0099bb'],[5,3,'#22ccee'],[7,3,'#22ccee'],[3,7,'#22ccee'],[9,7,'#22ccee']],'none');
MB.SPRITES['myth_heart_wraithwing'] = MB._px([[4,4,'#333355'],[5,4,'#333355'],[7,4,'#333355'],[8,4,'#333355'],[3,5,'#333355'],[4,5,'#8888aa'],[5,5,'#8888aa'],[6,5,'#333355'],[7,5,'#333355'],[8,5,'#333355'],[9,5,'#333355'],[3,6,'#333355'],[4,6,'#333355'],[5,6,'#333355'],[6,6,'#333355'],[7,6,'#333355'],[8,6,'#333355'],[9,6,'#333355'],[4,7,'#333355'],[5,7,'#333355'],[6,7,'#333355'],[7,7,'#333355'],[8,7,'#333355'],[5,8,'#333355'],[6,8,'#333355'],[7,8,'#333355'],[6,9,'#333355'],[5,3,'#555577'],[7,3,'#555577'],[3,7,'#555577'],[9,7,'#555577']],'none');

// ── SPRITE ACCESS ─────────────────────────────────────────────
MB.getSprite = function(id) {
  if (!id) return MB.SPRITES['?'];
  // Try direct id match
  const key = id.toLowerCase().replace(/\s+/g,'_').replace(/-/g,'_');
  return MB.SPRITES[key] || MB.SPRITES[id] || MB.SPRITES['?'];
};

// Returns an HTML string: the sprite SVG wrapped in a div at given size
MB.renderItemIcon = function(id, sizePx) {
  sizePx = sizePx || 32;
  const svg = MB.getSprite(id);
  return `<div style="width:${sizePx}px;height:${sizePx}px;image-rendering:pixelated;flex-shrink:0;">${svg}</div>`;
};

// Same but returns just the raw SVG with explicit dimensions set
MB.renderItemIconSVG = function(id, sizePx) {
  sizePx = sizePx || 32;
  const svg = MB.getSprite(id);
  return svg.replace('<svg ', `<svg width="${sizePx}" height="${sizePx}" `);
};


// ── AUTH GUARD ────────────────────────────────────────────────
// Call MB.requireAuth() at the top of every page script.
// If not signed in, redirects to auth page immediately.
// In production: replace isSignedIn() with supabase session check.
MB.requireAuth = function() {
  if (!MB.isSignedIn()) {
    window.location.href = 'mythbound_auth.html';
    return false;
  }
  return true;
};

// ── MAIL KEY (per-account) ────────────────────────────────────
MB.mailKey = function() {
  const s = MB.getSession();
  if (s && s.name) return 'mythbound_mail_v2_' + s.name.toUpperCase();
  return 'mythbound_mail_v2_GUEST';
};


// ── ITEM SEARCH ───────────────────────────────────────────────
// Used by admin panel and future auction house search.
// Returns array of {id, item} sorted by relevance.
MB.searchItems = function(query, opts) {
  opts = opts || {};
  const q = (query || '').toLowerCase().trim();
  if (!q) {
    // No query — return all items sorted by rarity then name
    return Object.entries(MB.ITEMS)
      .map(([id, item]) => ({ id, item }))
      .filter(({item}) => !opts.excludeType || item.type !== opts.excludeType)
      .sort((a,b) => (MB.RORD[b.item.rarity]||0) - (MB.RORD[a.item.rarity]||0) || a.item.name.localeCompare(b.item.name));
  }
  const results = [];
  Object.entries(MB.ITEMS).forEach(([id, item]) => {
    if (opts.excludeType && item.type === opts.excludeType) return;
    let score = 0;
    const name = (item.name || '').toLowerCase();
    const type = (item.type || '').toLowerCase();
    const rar  = (item.rarity || '').toLowerCase();
    const src  = (item.source || '').toLowerCase();
    const desc = (item.desc || '').toLowerCase();
    if (name === q)              score += 100;
    else if (name.startsWith(q)) score += 60;
    else if (name.includes(q))   score += 40;
    if (id.includes(q.replace(/\s+/g,'_'))) score += 30;
    if (type.includes(q))        score += 20;
    if (rar.includes(q))         score += 15;
    if (src.includes(q))         score += 10;
    if (desc.includes(q))        score += 5;
    if (score > 0) results.push({ id, item, score });
  });
  return results.sort((a,b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
};

// ── NAVIGATION ───────────────────────────────────────────────
MB.PAGES = {
  hub:        'mythbound_hub.html',
  games:      'mythbound_games.html',
  fishing:    'mythbound_fishing_lobby.html',
  mining:     'mythbound_mining.html',
  battle:     'mythbound_battle.html',
  inventory:  'mythbound_inventory.html',
  admin:      'mythbound_admin_minigames.html',
  dataeditor: 'mythbound_admin_data.html',
  mail:       'mythbound_mail.html',
  auction:    'mythbound_auction.html',
  auth:       'mythbound_auth.html',
};
MB.nav = function(page) {
  if (page === 'signout') {
    MB.signOut();
    return;
  }
  const dest = MB.PAGES[page];
  if (dest) window.location.href = dest;
  else console.warn('MB.nav: unknown page "' + page + '"');
};

MB.signOut = function() {
  // Clear session — in production: supabase.auth.signOut()
  if (MB.sendPresenceLeave) MB.sendPresenceLeave();
  // Best-effort: tell the server to drop our session token
  try {
    const s = MB.getSession();
    if (s && s.name && s.token && typeof fetch !== 'undefined') {
      const data = JSON.stringify({ name:s.name, token:s.token });
      if (navigator.sendBeacon) navigator.sendBeacon(MB.SERVER + '/__account/logout', new Blob([data],{type:'application/json'}));
      else fetch(MB.SERVER + '/__account/logout', { method:'POST', headers:{'Content-Type':'application/json'}, body:data, keepalive:true });
    }
  } catch(e){}
  localStorage.removeItem('mythbound_session_v1');
  window.location.href = 'mythbound_auth.html';
};

MB.isSignedIn = function() {
  try {
    const s = localStorage.getItem('mythbound_session_v1');
    return s ? !!JSON.parse(s).name : false;
  } catch(e) { return false; }
};

MB.getSession = function() {
  try {
    const s = localStorage.getItem('mythbound_session_v1');
    return s ? JSON.parse(s) : null;
  } catch(e) { return null; }
};

MB.setSession = function(user) {
  // user = { id, name, em, role, myth, level, ... }
  localStorage.setItem('mythbound_session_v1', JSON.stringify(user));
  // Reset MB.PLAYER to clean defaults before loading new account data
  // This prevents bleed-over when switching accounts
  MB.PLAYER.bag      = [];
  MB.PLAYER.equipped = {};
  MB.PLAYER.professions = {
    fishing:   { level:1, xp:0, xpMax:100 },
    mining:    { level:1, xp:0, xpMax:100 },
    herbalism: { level:1, xp:0, xpMax:100 },
    hunting:   { level:1, xp:0, xpMax:100 },
    combat:    { level:1, xp:0, xpMax:100 },
  };
  // Apply session data (from accounts store)
  const skip = ['password','token'];
  Object.keys(user).forEach(k => {
    if (!skip.includes(k)) MB.PLAYER[k] = user[k];
  });
  // Now load this account's full saved game data (overrides session defaults)
  MB.loadPlayer();
};

// ── RARITY ───────────────────────────────────────────────────
// Static hex for all rarities. Ultimate uses CSS animation —
// anywhere you'd set a color, use MB.ultimateStyle() instead.
MB.RC = {
  common:    '#999',
  uncommon:  '#6bff9b',
  rare:      '#6bb5ff',
  epic:      '#c455e8',
  legendary: '#ffdd6b',
  ultimate:  null,   // never a static hex — always animated CSS
};
MB.RORD = { common:0, uncommon:1, rare:2, epic:3, legendary:4, ultimate:5 };

// Returns inline style string for a rarity color (non-ultimate).
// For ultimate, use MB.ultimateClass() on the element instead.
MB.rarityColor = function(rar) {
  return MB.RC[rar] || '#fff';
};

// CSS to inject once per page — defines the rainbow animation
// and all .mb-ult-* helper classes.
MB.ULTIMATE_CSS = `
@keyframes mb-rainbow {
  0%   { filter: hue-rotate(0deg); }
  100% { filter: hue-rotate(360deg); }
}
@keyframes mb-rainbow-bg {
  0%   { background-position: 0% 50%; }
  100% { background-position: 200% 50%; }
}
/* Text that cycles through rainbow */
.mb-ult-text {
  background: linear-gradient(90deg,
    #ff0000,#ff8800,#ffff00,#00ff88,#00ccff,#8844ff,#ff0088,#ff0000);
  background-size: 200% auto;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  animation: mb-rainbow-bg 2.4s linear infinite;
}
/* Border wrapper: add 2px rainbow border around any block element */
.mb-ult-border {
  background: linear-gradient(90deg,
    #ff0000,#ff8800,#ffff00,#00ff88,#00ccff,#8844ff,#ff0088,#ff0000);
  background-size: 200% auto;
  animation: mb-rainbow-bg 2.4s linear infinite;
  padding: 2px;
  display: inline-block;
}
.mb-ult-border > * { background: #000; display: block; }
/* Badge: black text on sliding rainbow block */
.mb-ult-badge {
  background: linear-gradient(90deg,
    #ff0000,#ff8800,#ffff00,#00ff88,#00ccff,#8844ff,#ff0088,#ff0000);
  background-size: 200% auto;
  animation: mb-rainbow-bg 2.4s linear infinite;
  color: #000 !important;
  font-weight: bold;
  padding: 2px 6px;
}
/* Dot indicator */
.mb-ult-dot {
  background: linear-gradient(90deg,
    #ff0000,#ff8800,#ffff00,#00ff88,#00ccff,#8844ff,#ff0088,#ff0000);
  background-size: 200% auto;
  animation: mb-rainbow-bg 2.4s linear infinite;
}
/* Item link in chat */
.item-link.ultimate {
  background: linear-gradient(90deg,
    #ff0000,#ff8800,#ffff00,#00ff88,#00ccff,#8844ff,#ff0088,#ff0000);
  background-size: 200% auto;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  animation: mb-rainbow-bg 2.4s linear infinite;
  border-color: transparent;
  text-shadow: none;
}
`;

// Call once at page load to inject the CSS
MB.injectUltimateCSS = function() {
  if (document.getElementById('mb-ultimate-css')) return;
  const s = document.createElement('style');
  s.id = 'mb-ultimate-css';
  s.textContent = MB.ULTIMATE_CSS;
  document.head.appendChild(s);
};

// ── ITEM DATABASE ─────────────────────────────────────────────
// Master item list. Minigame drops reference item ids from here.
MB.ITEMS = {
  // EQUIPMENT
  iron_crown:      { name:'Iron Crown',     emoji:'⛑️', rarity:'rare',    type:'equipment', slot:'helm',     source:'drop',   sell:180, desc:'A battered crown taken from a dungeon guardian.',   stats:{def:8,stm:20},  element:'physical' },
  ashen_vest:      { name:'Ashen Vest',      emoji:'🦺', rarity:'uncommon',type:'equipment', slot:'chest',    source:'drop',   sell:90,  desc:'Leather hardened in volcanic ash.',                  stats:{def:5,stm:15},  element:'physical' },
  void_blade:      { name:'Void Blade',      emoji:'⚔️', rarity:'epic',   type:'equipment', slot:'main',     source:'drop',   sell:400, desc:'Forged from compressed darkness. Whispers when drawn.',stats:{atk:18,agi:2}, element:'void' },
  iron_shield:     { name:'Iron Shield',     emoji:'🛡️', rarity:'common',  type:'equipment', slot:'off',      source:'drop',   sell:80,  desc:'Heavy and dependable.',                              stats:{def:6,stm:10},  element:'physical' },
  silver_ring:     { name:'Silver Ring',     emoji:'💍', rarity:'uncommon',type:'equipment', slot:'ring',     source:'drop',   sell:110, desc:'Faintly magical. Hums when held.',                   stats:{wil:12,agi:1}, element:'arcana' },
  ember_boots:     { name:'Ember Boots',     emoji:'🥾', rarity:'rare',    type:'equipment', slot:'boots',    source:'drop',   sell:160, desc:'Warm to the touch. Forged in volcanic stone.',       stats:{agi:4,atk:3},  element:'fire' },
  sage_legs:       { name:'Sage Legguards',  emoji:'👖', rarity:'uncommon',type:'equipment', slot:'legs',     source:'drop',   sell:95,  desc:'Woven from enchanted bark-fiber.',                   stats:{wil:8,stm:12}, element:'nature' },
  crystal_trinket: { name:'Crystal Shard',   emoji:'💠', rarity:'epic',   type:'equipment', slot:'trinket',  source:'drop',   sell:350, desc:'A fragment of a shattered mana crystal.',            stats:{arc:14,wil:6}, element:'arcana' },
  // CONSUMABLES
  potion:          { name:'Potion',          emoji:'🧪',  rarity:'common',   type:'consumable', effect:'Heal 40 Stamina',    sell:20,  desc:'A basic healing potion.' },
  ether:           { name:'Ether',           emoji:'💧',  rarity:'common',   type:'consumable', effect:'Restore 30 MP',      sell:20,  desc:'Restores magical energy.' },
  elixir:          { name:'Elixir',          emoji:'⚗️',  rarity:'rare',     type:'consumable', effect:'Full Stamina + MP',  sell:200, desc:'Save it for when it counts.' },
  antidote:        { name:'Antidote',        emoji:'💊',  rarity:'common',   type:'consumable', effect:'Cure Venom',         sell:15,  desc:'Purges toxins.' },
  bomb:            { name:'Bomb',            emoji:'💣',  rarity:'uncommon', type:'consumable', effect:'60 Physical dmg',    sell:60,  desc:'Light fuse. Step back.' },
  // MATERIALS — Mining
  stone:           { name:'Stone',           emoji:'🪨',  rarity:'common',   type:'material', source:'mining', sell:2,   desc:'Basic stone.' },
  copper_ore:      { name:'Copper Ore',      emoji:'🟤',  rarity:'common',   type:'material', source:'mining', sell:10,  desc:'Smelts into copper ingots.' },
  tin_ore:         { name:'Tin Ore',         emoji:'⬜',  rarity:'uncommon', type:'material', source:'mining', sell:18,  desc:'Used in bronze alloys.' },
  iron_ore:        { name:'Iron Ore',        emoji:'🔩',  rarity:'common',   type:'material', source:'mining', sell:15,  desc:'Common and useful.' },
  coal:            { name:'Coal',            emoji:'⬛',  rarity:'uncommon', type:'material', source:'mining', sell:22,  desc:'Fuel and smithing input.' },
  silver_ore:      { name:'Silver Ore',      emoji:'🔘',  rarity:'common',   type:'material', source:'mining', sell:28,  desc:'Bright and conductive.' },
  quartz:          { name:'Quartz',          emoji:'💎',  rarity:'uncommon', type:'material', source:'mining', sell:35,  desc:'Alchemical reagent.' },
  mithril_ore:     { name:'Mithril Ore',     emoji:'🔵',  rarity:'rare',     type:'material', source:'mining', sell:300, desc:'Found only in deep veins.' },
  geode:           { name:'Geode',           emoji:'🔮',  rarity:'legendary',type:'material', source:'mining', sell:800, desc:'Crystalline wonder.' },
  // MATERIALS — Fishing
  root_fiber:      { name:'Root Fiber',      emoji:'🪢',  rarity:'common',   type:'material', source:'fishing', sell:8,   desc:'Used in leatherwork.' },
  ancient_sap:     { name:'Ancient Sap',     emoji:'🫙',  rarity:'rare',     type:'material', source:'fishing', sell:120, desc:'Alchemical reagent.' },
  shadow_gem:      { name:'Shadow Gem',      emoji:'💎',  rarity:'epic',     type:'material', source:'fishing', sell:500, desc:'Sought by enchanters.' },
  // KEY ITEMS
  deeproot_key:    { name:'Deeproot Key',    emoji:'🗝️',  rarity:'uncommon', type:'key',  sell:0,   desc:'Unlocks the Sealed Chamber.' },
  myth_heart:      { name:'Myth Heart',      emoji:'💜',  rarity:'ultimate', type:'key',  sell:0,   desc:'Used for myth binding. Soulbound — cannot trade or sell.', soulbound:true, usable:true },

  // MINING — processed materials
  iron_ingot:      { name:'Iron Ingot',     emoji:'🔩', rarity:'legendary', type:'material', source:'mining', sell:320, desc:'Smelted iron. Required for blacksmithing tier 2.' },
  silver_ingot:    { name:'Silver Ingot',   emoji:'🥈', rarity:'legendary', type:'material', source:'mining', sell:480, desc:'Refined silver bar. Prized by jewelers.' },
  mithril_bar:     { name:'Mithril Bar',    emoji:'🔵', rarity:'legendary', type:'material', source:'mining', sell:900, desc:'Smelted mithril. The backbone of endgame gear.' },
  adamant_frag:    { name:'Adamant Frag',   emoji:'💠', rarity:'uncommon',  type:'material', source:'mining', sell:55,  desc:'A shard of adamantine ore. Brittle but dense.' },
  // MINING — enemy drops
  slime_glob:      { name:'Slime Glob',     emoji:'🟢', rarity:'common',    type:'material', source:'mining', sell:8,   desc:'Viscous slime. Used in alchemy and leatherwork.' },
  slime_resin:     { name:'Slime Resin',    emoji:'🟡', rarity:'uncommon',  type:'material', source:'mining', sell:65,  desc:'Hardened slime extract. Alchemical reagent.' },
  slime_crown:     { name:'Slime Crown',    emoji:'👑', rarity:'legendary', type:'material', source:'mining', sell:750, desc:'Worn by the largest Shade Slimes. Proof of a worthy kill.' },
  rubble:          { name:'Rubble',         emoji:'🪨', rarity:'common',    type:'material', source:'mining', sell:4,   desc:'Broken stone fragments.' },
  golem_core:      { name:'Golem Core',     emoji:'🔷', rarity:'uncommon',  type:'material', source:'mining', sell:180, desc:'The animating crystal from a stone golem. Faintly warm.' },
  runed_heart:     { name:'Runed Heart',    emoji:'❤', rarity:'legendary', type:'material', source:'mining', sell:620, desc:'Carved from a golem\u2019s chest. The runes still pulse.' },
  // CHEST drops
  gold_pile:       { name:'Gold Pile',      emoji:'💰', rarity:'uncommon',  type:'material', source:'chest',  sell:200, desc:'A handful of raw gold fragments.' },
  gem_cache:       { name:'Gem Cache',      emoji:'💎', rarity:'rare',      type:'material', source:'chest',  sell:450, desc:'A pouch of mixed gemstones.' },
  ancient_relic:   { name:'Ancient Relic',  emoji:'🏺', rarity:'legendary', type:'material', source:'chest',  sell:900, desc:'Predates the current age. Scholars will pay well.' },
  // FISH
  perch:     { name:'Common Perch',    emoji:'🐟', rarity:'common',    type:'fish', source:'fishing', sell:12,  desc:'A plain river perch.' },
  roach:     { name:'River Roach',     emoji:'🐠', rarity:'common',    type:'fish', source:'fishing', sell:15,  desc:'Slippery little thing.' },
  carp:      { name:'Muddy Carp',      emoji:'🐡', rarity:'common',    type:'fish', source:'fishing', sell:22,  desc:'Bottom feeder.' },
  duck:      { name:'Angry Duck',      emoji:'🦆', rarity:'uncommon',  type:'fish', source:'fishing', sell:0,   desc:'It bit your line.' },
  eel:       { name:'River Eel',       emoji:'🐍', rarity:'uncommon',  type:'fish', source:'fishing', sell:60,  desc:'Long and pale.' },
  trout:     { name:'Speckled Trout',  emoji:'🐟', rarity:'uncommon',  type:'fish', source:'fishing', sell:80,  desc:'Good eating.' },
  bottle:    { name:'Sealed Bottle',   emoji:'🍶', rarity:'rare',      type:'fish', source:'fishing', sell:140, desc:'Something inside.' },
  pike:      { name:'Ghost Pike',      emoji:'🐊', rarity:'rare',      type:'fish', source:'fishing', sell:200, desc:'Massive. Translucent.' },
  afanc:     { name:'Afanc',           emoji:'🦎', rarity:'rare',      type:'fish', source:'fishing', sell:90,  desc:'Welsh lake beast.' },
  ahuizotl:  { name:'Ahuizotl',        emoji:'🦦', rarity:'rare',      type:'fish', source:'fishing', sell:160, desc:'Aztec river spirit.' },
  kelpie:    { name:'Kelpie',          emoji:'🐎', rarity:'rare',      type:'fish', source:'fishing', sell:150, desc:'Scottish water horse.' },
  aspido:    { name:'Aspidochelone',   emoji:'🐢', rarity:'rare',      type:'fish', source:'fishing', sell:250, desc:'Medieval island-turtle.' },
  tiddalik:  { name:'Tiddalik',        emoji:'🐸', rarity:'rare',      type:'fish', source:'fishing', sell:280, desc:'Frog that swallowed all water.' },
  koi_ryu:   { name:'Koi-Ryū',         emoji:'🐉', rarity:'epic',      type:'fish', source:'fishing', sell:620, desc:'Koi mid-ascension.' },
  mythcarp:  { name:'Mythbound Carp',  emoji:'🐲', rarity:'epic',      type:'fish', source:'fishing', sell:800, desc:'Mythic energy.' },
  leviathan: { name:'Leviathan Spawn', emoji:'🐍', rarity:'epic',      type:'fish', source:'fishing', sell:700, desc:'Coil of the Primordial Sea Beast.' },
  qallu:     { name:'Qallupilluit',    emoji:'🫧', rarity:'epic',      type:'fish', source:'fishing', sell:900, desc:'Inuit ice spirits.' },
  boot:      { name:'Old Boot',        emoji:'👟', rarity:'common',    type:'junk', source:'fishing', sell:0,   desc:'Someone lost a boot.' },

  // ── MYTH HEARTS (bound to myth slot on mythbinding) ─────────
  myth_heart_phoenix:   { name:'Phoenix Heart',    emoji:'❤️',  rarity:'ultimate', type:'key', slot:'myth', element:'fire',    sell:0, soulbound:true, mythBound:true, mythId:'phoenix',   color:'#ff6600', desc:'The bound heart of the Phoenix. Burns eternally.' },
  myth_heart_leviathan: { name:'Leviathan Heart',  emoji:'💙',  rarity:'ultimate', type:'key', slot:'myth', element:'frost',   sell:0, soulbound:true, mythBound:true, mythId:'leviathan',  color:'#0066ff', desc:'Thrums with the deep ocean.' },
  myth_heart_thunderoc: { name:'Thunderoc Heart',  emoji:'💛',  rarity:'ultimate', type:'key', slot:'myth', element:'arcana',  sell:0, soulbound:true, mythBound:true, mythId:'thunderoc',  color:'#ffdd00', desc:'Crackles with storm-born energy.' },
  myth_heart_voidwyrm:  { name:'Voidwyrm Heart',   emoji:'💜',  rarity:'ultimate', type:'key', slot:'myth', element:'void',    sell:0, soulbound:true, mythBound:true, mythId:'voidwyrm',   color:'#aa00ff', desc:'Pulses with the void between worlds.' },
  myth_heart_solarveil: { name:'Solarveil Heart',  emoji:'🤍',  rarity:'ultimate', type:'key', slot:'myth', element:'light',   sell:0, soulbound:true, mythBound:true, mythId:'solarveil',  color:'#ffffff', desc:'Radiates pure unfiltered light.' },
  myth_heart_emberbear: { name:'Emberbear Heart',  emoji:'🧡',  rarity:'ultimate', type:'key', slot:'myth', element:'fire',    sell:0, soulbound:true, mythBound:true, mythId:'emberbear',  color:'#ff4400', desc:'Warm as a hearthstone, fierce as a wildfire.' },
  myth_heart_moonshade: { name:'Moonshade Heart',  emoji:'🩵',  rarity:'ultimate', type:'key', slot:'myth', element:'arcana',  sell:0, soulbound:true, mythBound:true, mythId:'moonshade',  color:'#aaaaff', desc:'Shifts like moonlight on still water.' },
  myth_heart_stoneheart:{ name:'Stoneheart Heart', emoji:'🩶',  rarity:'ultimate', type:'key', slot:'myth', element:'physical',sell:0, soulbound:true, mythBound:true, mythId:'stoneheart', color:'#888888', desc:'Dense and unyielding as bedrock.' },
  myth_heart_tidecaller:{ name:'Tidecaller Heart', emoji:'💙',  rarity:'ultimate', type:'key', slot:'myth', element:'frost',   sell:0, soulbound:true, mythBound:true, mythId:'tidecaller', color:'#44ccff', desc:'Ebbs and flows like the tidal pulse.' },
  myth_heart_wraithwing:{ name:'Wraithwing Heart', emoji:'🖤',  rarity:'ultimate', type:'key', slot:'myth', element:'void',    sell:0, soulbound:true, mythBound:true, mythId:'wraithwing', color:'#666688', desc:'Cold to the touch. Barely there.' },
  phoenix_binding: { name:'Phoenix Binding', emoji:'🔥',  rarity:'ultimate', type:'key',  sell:0,   desc:'Your mythbound connection to the Phoenix. Cannot be removed or traded.', soulbound:true, mythBound:true },
};

// ── PROFESSIONS ───────────────────────────────────────────────
// Gathering professions have level-gated material tiers.
// Craft professions: one per player, full progress lost on switch.
MB.GATHERING_PROFS = ['fishing','mining','herbalism','hunting'];
MB.CRAFT_PROFS = ['blacksmithing','cooking','alchemy','leatherworking'];

MB.PROF_XP_TABLE = [
  { upTo:20, xpPerLevel:100  },
  { upTo:50, xpPerLevel:300  },
  { upTo:80, xpPerLevel:700  },
  { upTo:99, xpPerLevel:1500 },
  { upTo:100,xpPerLevel:3000 },
];
MB.xpForLevel = function(lvl) {
  const row = MB.PROF_XP_TABLE.find(r => lvl <= r.upTo);
  return row ? row.xpPerLevel : 3000;
};

// Economy: shop sell rates (player selling TO shop = lower than AH)
MB.SHOP_RATE = 0.4; // player gets 40% of sell value at NPC shop

// ── FISHING CONFIG ────────────────────────────────────────────
// FC is the live-tunable fishing config (also edited by admin panel).
// Admin panel writes to this via BroadcastChannel.
MB.FC = {
  bar:{ base:52, pxPerLevel:3, lureBonus:14 },
  catchRate:{ max:0.55, min:0.16, slope:0.0038 },
  patienceDrain:{ min:0.14, max:0.83, slope:0.0073, regenOnFish:0.012, catchBleedOff:0.06 },
  patienceComp:{ highThresh:0.20, lowThresh:0.12, highMult:0.80, midMult:0.90 },
  fish:{
    speedMult:0.055, velCapMult:2.2, wallBounce:-0.6,
    dartAmpFraction:0.80, dartAmpCapMult:1.4,
    behaviors:{
      smooth:  { damp:0.97, forceMult:0.65 },
      sinker:  { damp:0.98, gravity:0.22, gravitySpread:0.10, burstChance:0.022, burstMult:1.2, burstSpread:0.9 },
      floater: { damp:0.98, gravity:0.22, gravitySpread:0.10, burstChance:0.022, burstMult:1.2, burstSpread:0.9 },
      mixed:   { damp:0.95, forceMult:0.90 },
      dart:    { damp:0.82, forceMult:0.08 },
    },
    dartIntervals:{ dart:{min:12,spread:16}, mixed:{min:28,spread:28}, other:{min:50,spread:40} },
  },
  playerBar:{ accel:0.132, velCap:20, wallBounce:0.667 },
  timing:{ biteWaitMinMs:2000, biteWaitRandMs:4000, biteWindowMs:3000 },
  erratic:{ perLevelOver:0.20, cap:2.0, underBonus:0.82 },
  energyCostPerCatch: 40,
  rods:[
    { id:'basic', name:'WOODEN ROD', emoji:'🪡', tier:1, min:1, max:4, cost:0,    reqLvl:0, barBonus:0,  driftDamp:0,    desc:'Reliable. Gets the job done.',        stats:['BASE BAR +0px','STD REEL','LV1-4'] },
    { id:'fiber', name:'FIBER ROD',  emoji:'🎣', tier:2, min:5, max:8, cost:1200, reqLvl:4, barBonus:8,  driftDamp:0.97, desc:'Wider catch window. Less overshoot.', stats:['BASE BAR +8px','LESS DRIFT','LV5-8'] },
  ],
  bait:[
    { id:'none',  name:'BARE HOOK', emoji:'🪝', cost:0,  qty:999, consumable:false, poolKey:'none',  barBonus:0,  desc:'Standard rates.' },
    { id:'worm',  name:'WORM',      emoji:'🪱', cost:5,  qty:24,  consumable:true,  poolKey:'worm',  barBonus:0,  desc:'+Rare fish odds.' },
    { id:'lure',  name:'LURE',      emoji:'✨', cost:25, qty:8,   consumable:true,  poolKey:'lure',  barBonus:14, desc:'Big fish only. +14px bar.' },
    { id:'bread', name:'BREAD',     emoji:'🍞', cost:3,  qty:15,  consumable:true,  poolKey:'bread', barBonus:0,  desc:'Fast XP, common fish.' },
  ],
  tables:{
    none:[
      {id:'boot',     name:'Old Boot',        em:'👟',rar:'common',   diff:15,beh:'smooth', dartCh:0,    xp:3,  sell:0,  desc:"Someone lost a boot.",w:8},
      {id:'perch',    name:'Common Perch',    em:'🐟',rar:'common',   diff:25,beh:'smooth', dartCh:0.04, xp:12, sell:12, desc:"A plain river perch.",w:40},
      {id:'roach',    name:'River Roach',     em:'🐠',rar:'common',   diff:32,beh:'mixed',  dartCh:0.06, xp:14, sell:15, desc:"Slippery little thing.",w:32},
      {id:'carp',     name:'Muddy Carp',      em:'🐡',rar:'common',   diff:38,beh:'sinker', dartCh:0.06, xp:18, sell:22, desc:"Bottom feeder.",w:22},
      {id:'duck',     name:'Angry Duck',      em:'🦆',rar:'uncommon', diff:28,beh:'floater',dartCh:0.08, xp:30, sell:0,  desc:"It bit your line.",w:5},
      {id:'eel',      name:'River Eel',       em:'🫎',rar:'uncommon', diff:52,beh:'sinker', dartCh:0.10, xp:35, sell:60, desc:"Long and pale.",w:14},
      {id:'trout',    name:'Speckled Trout',  em:'🐟',rar:'uncommon', diff:58,beh:'mixed',  dartCh:0.12, xp:40, sell:80, desc:"Good eating.",w:12},
      {id:'bottle',   name:'Sealed Bottle',   em:'🍶',rar:'rare',     diff:42,beh:'smooth', dartCh:0.05, xp:50, sell:140,desc:"Something inside.",w:5},
      {id:'pike',     name:'Ghost Pike',      em:'🐊',rar:'rare',     diff:78,beh:'dart',   dartCh:0.22, xp:65, sell:200,desc:"Massive. Translucent.",w:4},
      {id:'afanc',    name:'Afanc',           em:'🦎',rar:'rare',     diff:62,beh:'sinker', dartCh:0.12, xp:55, sell:90, desc:"Welsh lake beast.",w:6,minLvl:5},
      {id:'ahuizotl', name:'Ahuizotl',        em:'🦦',rar:'rare',     diff:68,beh:'dart',   dartCh:0.18, xp:70, sell:160,desc:"Aztec river spirit.",w:4,minLvl:5},
      {id:'kelpie',   name:'Kelpie',          em:'🐎',rar:'rare',     diff:72,beh:'mixed',  dartCh:0.14, xp:65, sell:150,desc:"Scottish water horse.",w:4,minLvl:5},
      {id:'aspido',   name:'Aspidochelone',   em:'🐢',rar:'rare',     diff:74,beh:'smooth', dartCh:0.10, xp:80, sell:250,desc:"Medieval island-turtle.",w:3,minLvl:9},
      {id:'tiddalik', name:'Tiddalik',        em:'🐸',rar:'rare',     diff:78,beh:'floater',dartCh:0.16, xp:85, sell:280,desc:"Frog that swallowed all water.",w:3,minLvl:9},
      {id:'koi_ryu',  name:'Koi-Ryū',         em:'🐉',rar:'epic',     diff:86,beh:'mixed',  dartCh:0.22, xp:160,sell:620,desc:"Koi mid-ascension.",w:2,minLvl:9},
      {id:'mythcarp', name:'Mythbound Carp',  em:'🐲',rar:'epic',     diff:95,beh:'dart',   dartCh:0.32, xp:200,sell:800,desc:"Mythic energy.",w:1},
      {id:'leviathan',name:'Leviathan Spawn', em:'🐍',rar:'epic',     diff:92,beh:'dart',   dartCh:0.28, xp:180,sell:700,desc:"Coil of the Primordial Sea Beast.",w:2,minLvl:9},
      {id:'qallu',    name:'Qallupilluit',    em:'🫧',rar:'epic',     diff:95,beh:'dart',   dartCh:0.33, xp:220,sell:900,desc:"Inuit ice spirits.",w:1,minLvl:9},
    ],
    worm:[
      {id:'perch',    name:'Common Perch',    em:'🐟',rar:'common',   diff:25,beh:'smooth', dartCh:0.04, xp:12, sell:12, w:26},
      {id:'roach',    name:'River Roach',     em:'🐠',rar:'common',   diff:32,beh:'mixed',  dartCh:0.06, xp:14, sell:15, w:20},
      {id:'carp',     name:'Muddy Carp',      em:'🐡',rar:'common',   diff:38,beh:'sinker', dartCh:0.06, xp:18, sell:22, w:16},
      {id:'eel',      name:'River Eel',       em:'🫎',rar:'uncommon', diff:52,beh:'sinker', dartCh:0.10, xp:35, sell:60, w:20},
      {id:'trout',    name:'Speckled Trout',  em:'🐟',rar:'uncommon', diff:58,beh:'mixed',  dartCh:0.12, xp:40, sell:80, w:18},
      {id:'bottle',   name:'Sealed Bottle',   em:'🍶',rar:'rare',     diff:42,beh:'smooth', dartCh:0.05, xp:50, sell:140,w:7},
      {id:'pike',     name:'Ghost Pike',      em:'🐊',rar:'rare',     diff:78,beh:'dart',   dartCh:0.22, xp:65, sell:200,w:6},
      {id:'kelpie',   name:'Kelpie',          em:'🐎',rar:'rare',     diff:72,beh:'mixed',  dartCh:0.14, xp:65, sell:150,w:5,minLvl:5},
      {id:'koi_ryu',  name:'Koi-Ryū',         em:'🐉',rar:'epic',     diff:86,beh:'mixed',  dartCh:0.22, xp:160,sell:620,w:2,minLvl:9},
      {id:'leviathan',name:'Leviathan Spawn', em:'🐍',rar:'epic',     diff:92,beh:'dart',   dartCh:0.28, xp:180,sell:700,w:2,minLvl:9},
      {id:'mythcarp', name:'Mythbound Carp',  em:'🐲',rar:'epic',     diff:95,beh:'dart',   dartCh:0.32, xp:200,sell:800,w:2},
    ],
    lure:[
      {id:'trout',    name:'Speckled Trout',  em:'🐟',rar:'uncommon', diff:58,beh:'mixed',  dartCh:0.12, xp:40, sell:80, w:26},
      {id:'pike',     name:'Ghost Pike',      em:'🐊',rar:'rare',     diff:78,beh:'dart',   dartCh:0.22, xp:65, sell:200,w:22},
      {id:'eel',      name:'River Eel',       em:'🫎',rar:'uncommon', diff:52,beh:'sinker', dartCh:0.10, xp:35, sell:60, w:20},
      {id:'bottle',   name:'Sealed Bottle',   em:'🍶',rar:'rare',     diff:42,beh:'smooth', dartCh:0.05, xp:50, sell:140,w:10},
      {id:'kelpie',   name:'Kelpie',          em:'🐎',rar:'rare',     diff:72,beh:'mixed',  dartCh:0.14, xp:65, sell:150,w:8,minLvl:5},
      {id:'koi_ryu',  name:'Koi-Ryū',         em:'🐉',rar:'epic',     diff:86,beh:'mixed',  dartCh:0.22, xp:160,sell:620,w:5,minLvl:9},
      {id:'leviathan',name:'Leviathan Spawn', em:'🐍',rar:'epic',     diff:92,beh:'dart',   dartCh:0.28, xp:180,sell:700,w:4,minLvl:9},
      {id:'mythcarp', name:'Mythbound Carp',  em:'🐲',rar:'epic',     diff:95,beh:'dart',   dartCh:0.32, xp:200,sell:800,w:5},
      {id:'qallu',    name:'Qallupilluit',    em:'🫧',rar:'epic',     diff:95,beh:'dart',   dartCh:0.33, xp:220,sell:900,w:2,minLvl:9},
    ],
    bread:[
      {id:'perch',    name:'Common Perch',    em:'🐟',rar:'common',   diff:25,beh:'smooth', dartCh:0.04, xp:12, sell:12, w:42},
      {id:'carp',     name:'Muddy Carp',      em:'🐡',rar:'common',   diff:38,beh:'sinker', dartCh:0.06, xp:18, sell:22, w:36},
      {id:'roach',    name:'River Roach',     em:'🐠',rar:'common',   diff:32,beh:'mixed',  dartCh:0.06, xp:14, sell:15, w:22},
      {id:'boot',     name:'Old Boot',        em:'👟',rar:'common',   diff:15,beh:'smooth', dartCh:0,    xp:3,  sell:0,  w:14},
      {id:'duck',     name:'Angry Duck',      em:'🦆',rar:'uncommon', diff:28,beh:'floater',dartCh:0.08, xp:30, sell:0,  w:6},
      {id:'bottle',   name:'Sealed Bottle',   em:'🍶',rar:'rare',     diff:42,beh:'smooth', dartCh:0.05, xp:50, sell:140,w:4},
    ],
  },
};

// Admin panel can hot-patch FC via BroadcastChannel
MB.onBC(function(msg) {
  if (msg.type === 'fc_update') Object.assign(MB.FC, msg.data);
});

// ── MINING CONFIG ─────────────────────────────────────────────
MB.PICKAXES = {
  copper:  { name:'COPPER',  tier:1, damage:8,  energyCost:10 },
  iron:    { name:'IRON',    tier:2, damage:14, energyCost:18 },
  silver:  { name:'SILVER',  tier:3, damage:22, energyCost:30 },
  mithril: { name:'MITHRIL', tier:4, damage:40, energyCost:60 },
};
MB.ROCKS = {
  copper_rock:  { name:'COPPER ROCK',  tier:1, hp:40,  minLevel:1,  xp:12,  drops:[{item:'stone',      rarity:'common',   pixel:'#888',   weight:60},{item:'copper_ore', rarity:'common',   pixel:'#e8631a',weight:35},{item:'tin_ore',    rarity:'uncommon', pixel:'#c0c0c0',weight:4.9},{item:'geode',      rarity:'legendary',pixel:'#c455e8',weight:0.1}]},
  iron_rock:    { name:'IRON ROCK',    tier:2, hp:90,  minLevel:10, xp:30,  drops:[{item:'stone',      rarity:'common',   pixel:'#888',   weight:50},{item:'iron_ore',   rarity:'common',   pixel:'#a08070',weight:40},{item:'coal',       rarity:'uncommon', pixel:'#222',   weight:9.5},{item:'iron_ore',   rarity:'legendary',pixel:'#ddd',   weight:0.5}]},
  silver_rock:  { name:'SILVER ROCK',  tier:3, hp:150, minLevel:25, xp:55,  drops:[{item:'stone',      rarity:'common',   pixel:'#888',   weight:45},{item:'silver_ore', rarity:'common',   pixel:'#d0d0e0',weight:42},{item:'quartz',     rarity:'uncommon', pixel:'#eee',   weight:12.5},{item:'silver_ore', rarity:'legendary',pixel:'#fff',   weight:0.5}]},
  mithril_rock: { name:'MITHRIL ROCK', tier:4, hp:200, minLevel:50, xp:120, drops:[{item:'stone',      rarity:'common',   pixel:'#888',   weight:40},{item:'mithril_ore',rarity:'common',   pixel:'#9bd1e8',weight:45},{item:'quartz',     rarity:'uncommon', pixel:'#7ba8c4',weight:14.5},{item:'mithril_ore',rarity:'legendary',pixel:'#cfeaf5',weight:0.5}]},
};
MB.MINE_ENEMIES = [
  { key:'slime', name:'SHADE SLIME', tier:1, hp:50,  xp:18, minLevel:1,  maxLevel:999, shape:'SLIME', drops:[{item:'stone',rarity:'common',pixel:'#aaa',weight:65},{item:'quartz',rarity:'uncommon',pixel:'#888',weight:30},{item:'geode',rarity:'legendary',pixel:'#fff',weight:5}]},
  { key:'golem', name:'STONE GOLEM', tier:2, hp:95,  xp:45, minLevel:10, maxLevel:999, shape:'GOLEM', drops:[{item:'stone',rarity:'common',pixel:'#777',weight:55},{item:'copper_ore',rarity:'uncommon',pixel:'#6bb5ff',weight:38},{item:'mithril_ore',rarity:'legendary',pixel:'#cfeaf5',weight:7}]},
];

// ── ECONOMY CONSTANTS ──────────────────────────────────────────
MB.ECONOMY = {
  auctionListingFee: 0.05,   // 5% of listing price
  craftSwitchCost:   500,    // doubloons to reset craft profession (permanent choice at Lv.10)
  shopSellRate:      0.40,   // NPC shop pays 40% of item sell value
  mailDelay:         3600,   // 1 hour in seconds — player-to-player mail arrival delay
  mailMaxAttachments:10,     // max items per mail
  mailMaxCoins:      999999, // max doubloons per mail

  // ── FLAT PLAYER LEVEL ──────────────────────────────────────
  // Player level = floor(average of all active skill levels + craft level)
  // Active skills: fishing, mining, herbalism, hunting, combat
  // Craft skill: whichever the player chose (counts as one slot)
  // Max player level = 100
  calcPlayerLevel: function(player) {
    const profs = player.professions;
    const active = ['fishing','mining','herbalism','hunting','combat'];
    const activeSum = active.reduce((s,p) => s + (profs[p] ? profs[p].level : 1), 0);
    const craftLvl = player.craftLevel || 1;
    return Math.min(100, Math.floor((activeSum + craftLvl) / (active.length + 1)));
  },

  // ── TOOL TIERS ─────────────────────────────────────────────
  // Tool tier gates BOTH level content AND drop table access.
  // Player needs: correct tool tier AND sufficient skill level.
  // All tools crafted by Blacksmithing at the listed craft level.
  TOOL_TIERS: [
    { tier:1, name:'Starter',    craftReq:0,  craftSkill:null,          free:true,
      gatheringUnlock: { mining:1,  fishing:1,  herbalism:1,  hunting:1  } },
    { tier:2, name:'Iron',       craftReq:10, craftSkill:'blacksmithing',free:false,
      gatheringUnlock: { mining:20, fishing:15, herbalism:15, hunting:15 } },
    { tier:3, name:'Silver',     craftReq:30, craftSkill:'blacksmithing',free:false,
      gatheringUnlock: { mining:40, fishing:35, herbalism:35, hunting:35 } },
    { tier:4, name:'Mithril',    craftReq:60, craftSkill:'blacksmithing',free:false,
      gatheringUnlock: { mining:60, fishing:55, herbalism:55, hunting:55 } },
    { tier:5, name:'Adamantine', craftReq:90, craftSkill:'blacksmithing',free:false,
      gatheringUnlock: { mining:80, fishing:75, herbalism:75, hunting:75 } },
  ],

  // Returns the highest tool tier a player can USE (has equipped/owned)
  // In production this checks player.tools[profession]
  getToolTier: function(player, profession) {
    return player.tools ? (player.tools[profession] || 1) : 1;
  },

  // Returns whether a player can access content at a given level
  // Must satisfy BOTH skill level AND tool tier
  canAccess: function(player, profession, contentLevel) {
    const skillLevel = player.professions[profession]
      ? player.professions[profession].level : 1;
    const toolTier = MB.ECONOMY.getToolTier(player, profession);
    const tierDef = MB.ECONOMY.TOOL_TIERS[toolTier - 1];
    const toolUnlock = tierDef ? (tierDef.gatheringUnlock[profession] || 1) : 1;
    return skillLevel >= contentLevel && skillLevel >= toolUnlock;
  },

  // ── PROFESSION UNLOCK GATES (material access by mining level) ──
  miningUnlocks: [
    { level:1,  materials:['stone','copper_ore','tin_ore'] },
    { level:20, materials:['iron_ore','coal'] },
    { level:40, materials:['silver_ore','quartz'] },
    { level:60, materials:['gold_ore','obsidian'] },
    { level:80, materials:['mithril_ore'] },
    { level:100,materials:['starstone'] },
  ],

  // ── DROP RATE BONUSES ───────────────────────────────────────
  // Flat bonus to drop weight by level — legendary stays rare regardless
  dropRateLevelBonus: function(rarity, level) {
    const lb = level / 100;
    if (rarity === 'uncommon') return lb * 0.5;
    if (rarity === 'rare')     return lb * 0.7;
    if (rarity === 'legendary')return Math.min(lb * 0.3, 0.5); // hard cap — never farmable
    return 0;
  },
};

// Add tools and combat to player defaults if not present
if (!MB.PLAYER.tools) MB.PLAYER.tools = {
  fishing:'1', mining:'1', herbalism:'1', hunting:'1'
};
if (!MB.PLAYER.professions.combat) {
  MB.PLAYER.professions.combat = { level:1, xp:0, xpMax:100 };
}

// ── UTILITY ────────────────────────────────────────────────────
// Render a nav bar into any element. Highlights current page.
MB.renderNav = function(containerId, currentPage) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const signedIn = MB.isSignedIn();
  // Pages that require sign-in to access
  const gated = ['games','inventory','auction','mail'];
  const pages = [
    { key:'hub',      label:'HUB'       },
    { key:'games',    label:'GAMES'     },
    { key:'inventory',label:'INVENTORY' },
    { key:'auction',  label:'AUCTION',  wip:false },
    { key:'mail',     label:'MAIL'      },
    { key:'signout',  label: signedIn ? 'SIGN OUT' : 'SIGN IN', special:'signout' },
  ];
  el.innerHTML = pages.map(p => {
    const on  = p.key === currentPage ? ' on' : '';
    const wip = p.wip ? ' wip' : '';
    // Gated + not signed in: dim the button and route to auth
    const needsAuth = gated.includes(p.key) && !signedIn;
    const dim = (p.special === 'signout' || needsAuth)
      ? ' style="border-color:#333;color:#444;"' : '';
    let onclick;
    if (p.wip && !needsAuth) {
      onclick = ''; // wip and signed in — unclickable
    } else if (p.special === 'signout') {
      onclick = `onclick="${signedIn ? 'MB.signOut()' : "MB.nav('auth')"}"`;
    } else if (needsAuth) {
      onclick = `onclick="MB.nav('auth')"`;
    } else {
      onclick = `onclick="MB.nav('${p.key}')"`;
    }
    return `<button class="nb${on}${wip}"${dim} ${onclick}>${p.label}</button>`;
  }).join('');
};

// Render player bar into any element
MB.renderPlayerBar = function(containerId, opts) {
  opts = opts || {};
  const el = document.getElementById(containerId);
  if (!el) return;
  const p = MB.PLAYER;
  const prof = opts.profession;
  const xpData = prof ? p.professions[prof] : null;
  el.innerHTML = `
    <div class="pav">${p.em}</div>
    <div>
      <div class="pname">${p.name}</div>
      <div class="pinfo">Lv.${p.level} ${p.role}${p.myth ? ' · '+p.myth+' Mythbound' : ''}</div>
    </div>
    ${xpData ? `<div class="xp-wrap">
      <div class="xp-lbl">${prof.toUpperCase()} Lv.${xpData.level}</div>
      <div class="xp-bg"><div class="xp-f" style="width:${Math.round(xpData.xp/xpData.xpMax*100)}%"></div></div>
      <div class="xp-n">${xpData.xp}/${xpData.xpMax} XP</div>
    </div>` : ''}
    <div class="coins" style="margin-left:auto;">${p.coins.toLocaleString()} 🪙</div>
    ${opts.extra || ''}
  `;
};

// Load player data now that all MB.* functions are defined
MB.loadPlayer();
// ── GAME DATA LOADER ──────────────────────────────────────────
// Loads mythbound_data.json from the server and merges into MB.*
// If the file is missing (offline/file:// mode), JS defaults stay.
// Called automatically on shared.js load. All pages benefit.
MB.DATA = null; // populated after load

MB.loadGameData = async function() {
  try {
    const r = await fetch('http://localhost:3000/__data');
    if (!r.ok) return;
    const data = await r.json();
    MB.DATA = data;

    // Merge items — data file wins over JS hardcoded values
    if (data.items) {
      Object.entries(data.items).forEach(([id, item]) => {
        if (MB.ITEMS[id]) {
          Object.assign(MB.ITEMS[id], item);
        } else {
          MB.ITEMS[id] = item; // new item added via panel
        }
      });
    }

    // Merge economy flat values
    if (data.economy) {
      Object.entries(data.economy).forEach(([k, v]) => {
        if (typeof v !== 'object' && typeof v !== 'function') {
          MB.ECONOMY[k] = v;
        }
      });
    }

    // Merge mining rocks
    if (data.miningRocks) MB.ROCKS = data.miningRocks;

    // Merge mining enemies
    if (data.miningEnemies) MB.MINE_ENEMIES = data.miningEnemies;

    // Merge pickaxes
    if (data.pickaxes) MB.PICKAXES = data.pickaxes;

    // Merge rarity colors
    if (data.rarityColors) {
      Object.entries(data.rarityColors).forEach(([k,v]) => {
        if (v !== 'rainbow') MB.RC[k] = v;
      });
    }

    // Merge myths list (available for inventory mythbinding)
    if (data.myths) MB.MYTHS_DATA = data.myths;

    // Merge roles
    if (data.roles) MB.ROLES = data.roles;

    // Merge chat channels
    if (data.chat && data.chat.channels) MB.CHAT_CHANNELS = data.chat.channels;

    // Merge owner accounts
    if (data.ownerAccounts) MB.OWNER_ACCOUNTS = data.ownerAccounts;

    console.log('[MB] Game data loaded from mythbound_data.json');
  } catch(e) {
    console.log('[MB] Using JS defaults (data server not available)');
  }
};

// Save game data back to server (admin panel calls this after edits)
MB.saveGameData = async function(data) {
  try {
    const r = await fetch('http://localhost:3000/__data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!r.ok) throw new Error('Server returned ' + r.status);
    return true;
  } catch(e) {
    console.error('[MB] saveGameData failed:', e);
    return false;
  }
};

// Helper roles check — used by hub and admin panel
MB.ROLES = {}; // populated by loadGameData
MB.OWNER_ACCOUNTS = ['RAVEN'];
MB.CHAT_CHANNELS = [{id:'global',label:'GLOBAL'},{id:'trade',label:'TRADE'},{id:'lore',label:'LORE'}];
MB.MYTHS_DATA = [];

MB.getPlayerRole = function(name) {
  // Check accounts store for role field
  try {
    const accounts = JSON.parse(localStorage.getItem('mythbound_accounts_v1') || '{}');
    const acc = accounts[(name||'').toUpperCase()];
    if (acc && acc.role) return acc.role;
  } catch(e) {}
  return 'user';
};

MB.isOwner = function(name) {
  return MB.OWNER_ACCOUNTS.includes((name||'').toUpperCase());
};

MB.hasPermission = function(name, perm) {
  const role = MB.getPlayerRole(name);
  if (MB.isOwner(name)) return true;
  const roleDef = MB.ROLES[role];
  if (!roleDef) return false;
  return roleDef.permissions.includes('all') || roleDef.permissions.includes(perm);
};

// Store the load promise so pages can await it
MB.gameDataReady = MB.loadGameData();

// ── ITEM HYDRATION ────────────────────────────────────────────
// Re-hydrate a saved bag item from MB.ITEMS.
// Bag storage only needs {id, qty} — all other fields come from MB.ITEMS.
// This means data editor changes take effect on next page load automatically.
MB.hydrateItem = function(saved) {
  const def = MB.ITEMS[saved.id];
  if (!def) return saved; // unknown item — return as-is
  // Merge: definition fields first, then saved overrides (qty, equipped state etc)
  const hydrated = Object.assign({}, def, { id: saved.id });
  if (saved.qty !== undefined) hydrated.qty = saved.qty;
  return hydrated;
};

// Re-hydrate the player's entire bag and equipped from MB.ITEMS
MB.hydratePlayer = function() {
  // NOTE: bag stays as {id,qty} — never overwrite with full objects.
  // Only hydrate equipped slots (display only, not persisted via this call).
  if (MB.PLAYER.equipped) {
    Object.keys(MB.PLAYER.equipped).forEach(slot => {
      const eq = MB.PLAYER.equipped[slot];
      if (eq && eq.id) {
        if (eq.mythBound || eq.soulbound) return;
        MB.PLAYER.equipped[slot] = MB.hydrateItem(eq);
      }
    });
  }
};

// Read-only hydrated view of the bag — never mutates MB.PLAYER.bag
MB.getBag = function() {
  return (MB.PLAYER.bag || []).map(item => {
    const def = MB.ITEMS[item.id];
    if (!def) return Object.assign({ name: item.id, rarity:'common', type:'material' }, item);
    return Object.assign({}, def, { id: item.id, qty: item.qty || 1 });
  });
};

// Helper pages call at init: waits for game data then hydrates and calls callback
MB.onReady = function(callback) {
  MB.gameDataReady.then(() => {
    MB.hydratePlayer();
    if (callback) callback();
  });
};


// ── GLOBAL NOTIFICATION POLL ─────────────────────────────────
// Runs on every page — polls server for whispers + social events.
// BroadcastChannel pushes received events to hub tab if open.
// In production: swap for Supabase Realtime subscription.
MB._notifChannel = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('mythbound_notifications') : null;
MB._notifPollTimer = null;

MB.startNotifPoll = function() {
  if (MB._notifPollTimer) return;
  if (!MB.isSignedIn()) return;
  const myName = (MB.PLAYER.name || '').toUpperCase();
  MB._notifPollTimer = setInterval(async () => {
    if (!MB.isSignedIn()) return;
    // ── Whispers ── (skip if the current page runs its own whisper poll,
    //  e.g. the hub — otherwise both would drain the same queue and lose msgs)
    if (!MB._ownWhisperPoll) {
      try {
        const r = await fetch(MB.SERVER + '/__whisper/poll?name=' + encodeURIComponent(myName));
        if (r.ok) {
          const msgs = await r.json();
          if (msgs && msgs.length) {
            if (MB._notifChannel) MB._notifChannel.postMessage({ type:'whispers', msgs });
            msgs.forEach(m => {
              if (MB._handleIncomingWhisper) MB._handleIncomingWhisper(m);
              else if (typeof toast === 'function') { try { toast('\u25b8 Whisper from ' + (m.from||'?')); } catch(e){} }
            });
          }
        }
      } catch(e) {}
    }
    // Social is now authoritative via /__social/get (polled per-page); nothing to do here.
  }, 2500);
};
if (MB.isSignedIn()) MB.startNotifPoll();


// ── PAGE PRESENCE ─────────────────────────────────────────────
// Call MB.setPresence('Mining') from any page to broadcast current activity.
// Hub reads this via /__presence/list and shows it in the online list.
MB._presenceInterval = null;
MB._presenceLabel    = 'In Hub';

MB.setPresence = function(label) {
  MB._presenceLabel = label;
  MB._sendHeartbeat(); // fire immediately on label change
};

MB._sendHeartbeat = async function() {
  if (!MB.isSignedIn() || !MB.PLAYER.name) return;
  try {
    await fetch('http://localhost:3000/__presence/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:  MB.PLAYER.name,
        em:    MB.PLAYER.em   || '?',
        page:  MB._presenceLabel,
        myth:  MB.PLAYER.myth || null,
        level: MB.PLAYER.level || 1,
        role:  MB.PLAYER.role  || 'Adventurer',
      }),
    });
  } catch(e) {}
};

// Start heartbeat loop — called once per page. 20s interval is enough;
// hub refreshes every 8s so worst-case lag is 20s which is imperceptible.
MB.startPresenceHeartbeat = function(label) {
  if (MB._presenceInterval) clearInterval(MB._presenceInterval);
  if (label) MB._presenceLabel = label;
  MB._sendHeartbeat();
  MB._presenceInterval = setInterval(MB._sendHeartbeat, 20000);
};

// ── PRESENCE REPORTER ────────────────────────────────────────
// Included in shared.js so every page auto-reports without per-page changes.
// Hub reads /__presence/list every 8s to show the online list.

MB._pageLabels = {
  'mythbound_auction.html':   'Auction House',
  'mythbound_hub.html':          'In Hub',
  'mythbound_games.html':        'Games',
  'mythbound_fishing_lobby.html':'Fishing',
  'mythbound_mining.html':       'Mining',
  'mythbound_battle.html':       'Battle',
  'mythbound_inventory.html':    'Inventory',
  'mythbound_mail.html':         'Mail',
  'mythbound_auth.html':         'Login',
  'mythbound_admin_data.html':   'Admin Panel',
  'mythbound_admin_minigames.html': 'Admin Panel',
};

MB.getPageLabel = function() {
  const file = window.location.pathname.split('/').pop() || 'mythbound_hub.html';
  return MB._pageLabels[file] || file.replace('mythbound_','').replace('.html','');
};

MB._presenceInterval = null;

MB.sendPresencePing = async function() {
  if (!MB.isSignedIn() || !MB.PLAYER.name) return;
  try {
    const r = await fetch('http://localhost:3000/__presence/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:  MB.PLAYER.name,
        em:    MB.PLAYER.em   || '?',
        page:  MB.getPageLabel(),
        myth:  MB.PLAYER.myth || null,
        level: MB.PLAYER.level || 1,
        role:  MB.PLAYER.role  || 'Adventurer',
        token: MB._sessionToken ? MB._sessionToken() : null,
      }),
    });
    if (r.ok) {
      const res = await r.json();
      // Single-session enforcement: server says a newer login replaced us.
      if (res && res.sessionValid === false) MB._handleKicked();
    }
  } catch(e) {}
};

MB.startPresenceReporter = function() {
  if (MB._presenceInterval) return;
  if (!MB.isSignedIn()) return;
  // Ping immediately, then every 15s
  MB.sendPresencePing();
  MB._presenceInterval = setInterval(MB.sendPresencePing, 15000);
  // Stop reporting when tab is hidden to save requests
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearInterval(MB._presenceInterval);
      MB._presenceInterval = null;
    } else {
      // Tab visible again — ping immediately then restart interval
      MB.sendPresencePing();
      MB._presenceInterval = setInterval(MB.sendPresencePing, 15000);
    }
  });
};

// Auto-start on every page once player is loaded
// Uses gameDataReady so MB.PLAYER.name is guaranteed
if (typeof window !== 'undefined') {
  if (MB.gameDataReady && MB.gameDataReady.then) {
    MB.gameDataReady.then(() => MB.startPresenceReporter()).catch(() => MB.startPresenceReporter());
  } else {
    setTimeout(MB.startPresenceReporter, 500);
  }
}

MB.sendPresenceLeave = function() {
  if (!MB.isSignedIn() || !MB.PLAYER.name) return;
  // sendBeacon works even during page unload — fetch does not
  const data = JSON.stringify({ name: MB.PLAYER.name });
  try {
    navigator.sendBeacon('http://localhost:3000/__presence/leave',
      new Blob([data], { type: 'application/json' }));
  } catch(e) {
    // Fallback for browsers without sendBeacon
    try { fetch('http://localhost:3000/__presence/leave', { method:'POST', headers:{'Content-Type':'application/json'}, body:data, keepalive:true }); } catch(e2) {}
  }
};

// Fire leave on tab close, navigation away, or refresh
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => MB.sendPresenceLeave());
  window.addEventListener('pagehide',     () => MB.sendPresenceLeave());
}

console.log('[MB] mythbound_shared.js loaded');
