// ============================================================
//  MYTHBOUND — Local Dev Server
//  1. Put this file in your mythbound/ folder
//  2. Run: node server.js
//  3. Open: http://localhost:3000
// ============================================================

const http = require('http');
const fs   = require('fs');
const path = require('path');
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

// ── LIVE RELOAD ───────────────────────────────────────────────
const reloadClients = [];
let reloadTimer = null;
function scheduleReload(filename) {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    console.log('  ↻ changed:', filename, '— reloading browser');
    reloadClients.forEach(res => { try { res.write('data: reload\n\n'); } catch(e) {} });
    reloadClients.length = 0;
  }, 80);
}
function watchDir(dir) {
  try {
    fs.readdirSync(dir).forEach(f => {
      const full = path.join(dir, f);
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory() && f !== 'node_modules' && !f.startsWith('.')) watchDir(full);
        else if (stat.isFile() && !f.startsWith('.') && f !== 'mythbound_ah.json') fs.watch(full, () => scheduleReload(f));
      } catch(e) {}
    });
  } catch(e) {}
}
watchDir(ROOT);

const RELOAD_SNIPPET = `
<script>
(function(){
  var es = new EventSource('/__reload');
  es.onmessage = function(e){ if(e.data==='reload') location.reload(); };
  es.onerror   = function(){ setTimeout(function(){ location.reload(); }, 1500); };
})();
</script>`;

// ── CHAT SYNC ─────────────────────────────────────────────────
// In-memory chat log per channel — cleared on server restart.
// In production: replace with Supabase Realtime subscriptions.
// Clients connect to /__chat/stream, POST to /__chat/send.
// Server fans messages out to all connected SSE clients instantly.

const MAX_HISTORY = 200;
// chatHistory[channel] = array of message objects
const chatHistory = {};
const chatClients = []; // { res, channel }

function getHistory(channel) {
  if (!chatHistory[channel]) chatHistory[channel] = [];
  return chatHistory[channel];
}

function broadcastChat(msg) {
  const json = 'data: ' + JSON.stringify(msg) + '\n\n';
  chatClients.forEach(client => {
    if (client.channel === msg.channel || client.channel === 'all') {
      try { client.res.write(json); } catch(e) {}
    }
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 64000) reject(new Error('Too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}

// ============================================================
//  ACCOUNTS / SAVES / MAIL / SESSIONS  (server source of truth)
//  Persisted to .mythbound_accounts.json (atomic, debounced).
//  Migrate to Supabase later by swapping these fns for table I/O.
// ============================================================
const ACCT_FILE = path.join(ROOT, '.mythbound_accounts.json');
function _loadAccts() {
  try {
    if (fs.existsSync(ACCT_FILE)) {
      const d = JSON.parse(fs.readFileSync(ACCT_FILE, 'utf8'));
      return { accounts:d.accounts||{}, saves:d.saves||{}, mail:d.mail||{}, sessions:d.sessions||{},
               social:d.social||{}, whispers:d.whispers||{} };
    }
  } catch(e) { console.error('[acct] load failed:', e.message); }
  return { accounts:{}, saves:{}, mail:{}, sessions:{}, social:{}, whispers:{} };
}
const ACCT = _loadAccts();
let _acctTimer = null;
function saveAccts()    { clearTimeout(_acctTimer); _acctTimer = setTimeout(saveAcctsNow, 120); }
function saveAcctsNow() {
  try { const tmp = ACCT_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(ACCT)); fs.renameSync(tmp, ACCT_FILE); }
  catch(e) { console.error('[acct] save failed:', e.message); }
}
function newToken() { return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10); }

// ── SOCIAL GRAPH (authoritative, persisted) ──────────────────
//  Per account: friends[], blocked[], incoming[] (requests TO me),
//  outgoing[] (requests I sent), invites[] ({from,type}).
function getSocial(name) {
  const key = (name||'').toUpperCase();
  if (!ACCT.social[key]) ACCT.social[key] = { friends:[], blocked:[], incoming:[], outgoing:[], invites:[] };
  const s = ACCT.social[key];
  s.friends = s.friends||[]; s.blocked = s.blocked||[]; s.incoming = s.incoming||[];
  s.outgoing = s.outgoing||[]; s.invites = s.invites||[];
  return s;
}
const _pull = (arr, val) => { const i = arr.indexOf(val); if (i!==-1) arr.splice(i,1); };
const _push = (arr, val) => { if (!arr.includes(val)) arr.push(val); };

// ── WHISPER THREADS (persisted) ──────────────────────────────
//  ACCT.whispers[NAME] = { OTHER: [ {from,to,text,ts} ] }  (capped per thread)
const WHISPER_CAP = 100;
function whisperThread(owner, other) {
  const o = (owner||'').toUpperCase(), x = (other||'').toUpperCase();
  if (!ACCT.whispers[o]) ACCT.whispers[o] = {};
  if (!ACCT.whispers[o][x]) ACCT.whispers[o][x] = [];
  return ACCT.whispers[o][x];
}

// ── TRADING (authoritative, atomic swaps on server saves) ────
//  Trades are ephemeral (in-memory). Each session has two sides, each with
//  an offer (items + coins) and a confirmed flag. The swap only executes when
//  BOTH sides confirm, and is validated against the live server saves so items
//  can never be duplicated or conjured.
const TRADES = {};
function newTradeId() { return 'tr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,7); }
function activeTradeFor(name) {
  const k = (name||'').toUpperCase();
  return Object.values(TRADES).find(t => t.status==='open' && (t.a.name===k || t.b.name===k)) || null;
}
// Most recent trade involving name that's still worth reporting (open, or
// finished within the last 10s so the other side learns the outcome).
function reportableTradeFor(name) {
  const k = (name||'').toUpperCase();
  const now = Date.now();
  return Object.values(TRADES)
    .filter(t => (t.a.name===k || t.b.name===k) && (t.status==='open' || (t.ended && now - t.ended < 10000)))
    .sort((x,y) => (y.updated||0) - (x.updated||0))[0] || null;
}
function tradeSide(t, name)  { const k=(name||'').toUpperCase(); return t.a.name===k ? t.a : (t.b.name===k ? t.b : null); }
function bagCount(save, itemId) { const it=(save.bag||[]).find(i=>i.id===itemId); return it ? (it.qty||0) : 0; }
function bagRemove(save, itemId, qty) {
  const bag = save.bag||[]; const it = bag.find(i=>i.id===itemId);
  if (!it || (it.qty||0) < qty) return false;
  it.qty -= qty; if (it.qty <= 0) bag.splice(bag.indexOf(it),1);
  save.bag = bag; return true;
}
function bagAdd(save, itemId, qty) {
  if (!save.bag) save.bag = [];
  const it = save.bag.find(i=>i.id===itemId);
  if (it) it.qty = (it.qty||0) + qty; else save.bag.push({ id:itemId, qty });
}
function sanitizeOffer(items) {
  return (Array.isArray(items)?items:[])
    .filter(i => i && i.itemId && Number(i.qty) > 0)
    .map(i => ({ itemId:String(i.itemId), qty:Math.max(1, Math.floor(Number(i.qty))) }));
}
function executeTrade(t) {
  const A = ACCT.saves[t.a.name], B = ACCT.saves[t.b.name];
  if (!A || !B) { t.status='cancelled'; t.error='A player save is missing.'; return; }
  // Validate BOTH sides fully before moving anything (atomic).
  for (const it of t.a.offer) if (bagCount(A,it.itemId) < it.qty) { t.status='cancelled'; t.error=t.a.name+' no longer has the offered items.'; return; }
  for (const it of t.b.offer) if (bagCount(B,it.itemId) < it.qty) { t.status='cancelled'; t.error=t.b.name+' no longer has the offered items.'; return; }
  if ((A.coins||0) < (t.a.coins||0)) { t.status='cancelled'; t.error=t.a.name+' lacks the offered coins.'; return; }
  if ((B.coins||0) < (t.b.coins||0)) { t.status='cancelled'; t.error=t.b.name+' lacks the offered coins.'; return; }
  // Apply.
  t.a.offer.forEach(it => { bagRemove(A,it.itemId,it.qty); bagAdd(B,it.itemId,it.qty); });
  t.b.offer.forEach(it => { bagRemove(B,it.itemId,it.qty); bagAdd(A,it.itemId,it.qty); });
  A.coins = (A.coins||0) - (t.a.coins||0) + (t.b.coins||0);
  B.coins = (B.coins||0) - (t.b.coins||0) + (t.a.coins||0);
  t.status = 'complete';
  saveAcctsNow();
}
function tradePublic(t) {
  return { id:t.id, status:t.status, error:t.error||null,
    a:{ name:t.a.name, offer:t.a.offer, coins:t.a.coins, confirmed:t.a.confirmed },
    b:{ name:t.b.name, offer:t.b.offer, coins:t.b.coins, confirmed:t.b.confirmed } };
}

function buildAccount({ name, em, email, password, role, myth, level }) {
  const NAME = name.toUpperCase();
  return {
    id:'acc_'+NAME.toLowerCase(), name:NAME, em:em||'\uD83E\uDDD9',
    email:email||(NAME.toLowerCase()+'@mythbound.dev'),
    password:password, role:role||'Adventurer', myth:myth||null, level:level||1,
  };
}
function starterSave(acc, overrides) {
  return Object.assign({
    coins:500, energy:1000, energyMax:1000,
    professions:{
      fishing:{level:1,xp:0,xpMax:100}, mining:{level:1,xp:0,xpMax:100},
      herbalism:{level:1,xp:0,xpMax:100}, hunting:{level:1,xp:0,xpMax:100},
      combat:{level:1,xp:0,xpMax:100},
    },
    bag:[], equipped:{}, bagSlots:20,
    tools:{fishing:'1',mining:'1',herbalism:'1',hunting:'1'},
    craft:null, craftLevel:1, craftXp:0, myth:acc.myth||null,
  }, overrides||{});
}
function seedMailbox(NAME) {
  const now = Date.now();
  return [
    { id:'sys_welcome', from:'MYTHBOUND', to:NAME, type:'system', subject:'Welcome to MYTHBOUND!',
      body:'Welcome, adventurer.\n\nYour journey begins here. Gather resources, master your craft, and forge bonds with fellow players.\n\nThe world is watching.\n\n\u2014 The MYTHBOUND Team',
      coins:100, attachments:[], sent_at:now-7200000, arrives_at:now-7200000,
      read:false, taken:false, takenItems:{}, coinsTaken:false, deleted:false },
    { id:'sys_patch', from:'MYTHBOUND', to:NAME, type:'system', subject:'Patch Notes \u2014 Update 0.1',
      body:'\u25b8 Mining minigame now live\n\u25b8 Fishing minigame now live\n\u25b8 Inventory system active\n\u25b8 Mail system launched\n\u25b8 Economy foundations in place\n\nMore content coming soon. Thank you for testing!\n\n\u2014 The MYTHBOUND Team',
      coins:0, attachments:[], sent_at:now-3600000, arrives_at:now-3600000,
      read:true, taken:false, takenItems:{}, coinsTaken:false, deleted:false },
  ];
}
const DUMMY_SEED = [
  { name:'RAVEN',   em:'\uD83D\uDC26\u200D\u2B1B', password:'raven123',  role:'Striker',    myth:'Phoenix',  level:12, profOverride:{fishing:4,mining:2,combat:8} },
  { name:'FOXPAW',  em:'\uD83E\uDD8A',             password:'foxpaw123', role:'Ranger',     myth:null,       level:5  },
  { name:'CINDRA',  em:'\uD83D\uDD25',             password:'cindra123', role:'Pyromancer', myth:'Ember',    level:6  },
  { name:'GREYVEIL',em:'\uD83C\uDF2B\uFE0F',       password:'grey123',   role:'Warden',     myth:null,       level:4  },
  { name:'SOLENNE', em:'\u2728',                   password:'sol123',    role:'Cleric',     myth:'Starborn', level:7  },
];
function seedDummies() {
  let changed = false;
  DUMMY_SEED.forEach(d => {
    const key = d.name.toUpperCase();
    if (!ACCT.accounts[key]) {
      const acc = buildAccount(d);
      ACCT.accounts[key] = acc;
      const save = starterSave(acc);
      if (d.profOverride) Object.entries(d.profOverride).forEach(([p,lvl]) => { if (save.professions[p]) save.professions[p].level = lvl; });
      ACCT.saves[key] = save;
      if (!ACCT.mail[key]) ACCT.mail[key] = seedMailbox(key);
      changed = true;
    }
  });
  if (changed) saveAcctsNow();
}
function publicUser(acc) { const { password, ...rest } = acc; return rest; }
function sessionValid(name, token) {
  const s = ACCT.sessions[(name||'').toUpperCase()];
  return !!(s && token && s.token === token);
}
seedDummies();
console.log('  [acct] ' + Object.keys(ACCT.accounts).length + ' account(s) loaded');

// ── SERVER ────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  // CORS for same-origin dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Live reload SSE ──
  if (url === '/__reload') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write(':\n\n');
    reloadClients.push(res);
    req.on('close', () => { const i = reloadClients.indexOf(res); if (i !== -1) reloadClients.splice(i, 1); });
    return;
  }

  // ── Chat stream (SSE) — GET /__chat/stream?channel=global ──
  if (url.startsWith('/__chat/stream')) {
    const channel = new URL(req.url, 'http://localhost').searchParams.get('channel') || 'global';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write(':\n\n');
    // Send history on connect
    const hist = getHistory(channel);
    if (hist.length) res.write('data: ' + JSON.stringify({ type: 'history', messages: hist }) + '\n\n');
    const client = { res, channel };
    chatClients.push(client);
    req.on('close', () => { const i = chatClients.indexOf(client); if (i !== -1) chatClients.splice(i, 1); });
    // Keep-alive ping every 20s
    const ping = setInterval(() => { try { res.write(':\n\n'); } catch(e) { clearInterval(ping); } }, 20000);
    req.on('close', () => clearInterval(ping));
    return;
  }

  // ── Chat send — POST /__chat/send ──
  if (url === '/__chat/send' && req.method === 'POST') {
    try {
      const msg = await parseBody(req);
      if (!msg || !msg.channel || !msg.text || !msg.name) {
        res.writeHead(400); res.end('Bad request'); return;
      }
      // Sanitise
      msg.text    = String(msg.text).slice(0, 500);
      msg.name    = String(msg.name).slice(0, 32);
      msg.em      = String(msg.em  || '?').slice(0, 8);
      msg.ts      = Date.now();
      msg.id      = msg.id || msg.name.toLowerCase();
      msg.type    = msg.type || 'chat';
      // Store
      const hist = getHistory(msg.channel);
      hist.push(msg);
      if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY);
      // Broadcast
      broadcastChat(msg);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ts: msg.ts }));
    } catch(e) {
      res.writeHead(500); res.end('Error: ' + e.message);
    }
    return;
  }

  // ── Chat history — GET /__chat/history?channel=global ──
  if (url.startsWith('/__chat/history')) {
    const channel = new URL(req.url, 'http://localhost').searchParams.get('channel') || 'global';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getHistory(channel)));
    return;
  }


  // ── Game data — GET /__data ──
  if (url === '/__data' && req.method !== 'POST') {
    try {
      const data = fs.readFileSync(path.join(ROOT, 'mythbound_data.json'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch(e) {
      res.writeHead(404); res.end('mythbound_data.json not found');
    }
    return;
  }

  // ── Game data save — POST /__data ──
  if (url === '/__data' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      // Safety: validate it has required keys before writing
      if (!body.items || !body.economy) {
        res.writeHead(400); res.end('Invalid data: missing items or economy'); return;
      }
      // Write atomically: temp file then rename
      const dest = path.join(ROOT, 'mythbound_data.json');
      const tmp  = dest + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8');
      fs.renameSync(tmp, dest);
      console.log('  ✓ mythbound_data.json saved (' + JSON.stringify(body).length + ' bytes)');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      console.error('  ✗ data save failed:', e.message);
      res.writeHead(500); res.end('Save failed: ' + e.message);
    }
    return;
  }


  // Favicon — suppress 404 noise
  if (url === '/favicon.ico') {
    res.writeHead(204); res.end(); return;
  }


// ── QUEUES — persisted to disk so server restarts don't wipe them ──
const QUEUES_FILE = path.join(ROOT, '.mythbound_queues.json');
function loadQueues() {
  try { if (fs.existsSync(QUEUES_FILE)) { const d = JSON.parse(fs.readFileSync(QUEUES_FILE,'utf8')); return {social:d.social||{},whispers:d.whispers||{},presence:d.presence||{},ahMail:d.ahMail||{}}; } } catch(e) {}
  return {social:{},whispers:{},presence:{},ahMail:{}};
}
function saveQueues() {
  try { fs.writeFileSync(QUEUES_FILE, JSON.stringify({social:socialPending,whispers:whisperQueue,presence:presenceMap,ahMail:ahMailQueue})); } catch(e) {}
}
const _q = loadQueues();
const socialPending = _q.social;
const whisperQueue  = _q.whispers;
const ahMailQueue   = _q.ahMail || {}; // legacy AH queue; declared here so saveQueues() never refs an undeclared var
const presenceMap   = _q.presence || {};
// Clear stale presence on start (older than 60s)
const _now = Date.now();
Object.keys(presenceMap).forEach(k => { if (_now - presenceMap[k].ts > 60000) delete presenceMap[k]; });
// SSE push clients — instant delivery when online
const whisperClients = {};
const socialClients  = {};
function pushSSE(registry, name, data) {
  const res = registry[name.toUpperCase()];
  if (!res) return false;
  try { res.write('data: ' + JSON.stringify(data) + '\n\n'); return true; } catch(e) { delete registry[name.toUpperCase()]; return false; }
}
function getSocialPending(name) {
  const key = name.toUpperCase();
  if (!socialPending[key]) socialPending[key] = {requests:[],invites:[]};
  return socialPending[key];
}



  // ── Whisper SSE stream — GET /__whisper/stream?name=RAVEN ──
  if (url.startsWith('/__whisper/stream')) {
    const name = (new URL(req.url,'http://localhost').searchParams.get('name')||'').toUpperCase();
    if (!name) { res.writeHead(400); res.end('name required'); return; }
    res.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
    res.write(':\n\n');
    whisperClients[name] = res;
    // Flush queued messages
    const queued = whisperQueue[name]||[];
    if (queued.length) { queued.forEach(m => res.write('data: '+JSON.stringify(m)+'\n\n')); whisperQueue[name]=[]; saveQueues(); }
    const ping = setInterval(()=>{ try{res.write(':\n\n');}catch(e){clearInterval(ping);} },20000);
    req.on('close',()=>{ clearInterval(ping); delete whisperClients[name]; });
    return;
  }

  // ── Social SSE stream — GET /__social/stream?name=RAVEN ──
  if (url.startsWith('/__social/stream')) {
    const name = (new URL(req.url,'http://localhost').searchParams.get('name')||'').toUpperCase();
    if (!name) { res.writeHead(400); res.end('name required'); return; }
    res.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
    res.write(':\n\n');
    socialClients[name] = res;
    const p = getSocialPending(name);
    if (p.requests.length||p.invites.length) { res.write('data: '+JSON.stringify({requests:[...p.requests],invites:[...p.invites]})+'\n\n'); p.requests=[]; p.invites=[]; saveQueues(); }
    const ping = setInterval(()=>{ try{res.write(':\n\n');}catch(e){clearInterval(ping);} },20000);
    req.on('close',()=>{ clearInterval(ping); delete socialClients[name]; });
    return;
  }

  // ── Social: get authoritative graph ── GET /__social/get?name=RAVEN ──
  if (url.startsWith('/__social/get')) {
    const name = (new URL(req.url,'http://localhost').searchParams.get('name')||'').toUpperCase();
    const s = getSocial(name);
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ friends:[...s.friends], blocked:[...s.blocked], incoming:[...s.incoming], outgoing:[...s.outgoing], invites:[...s.invites] }));
    return;
  }

  // ── Social: graph mutation ── POST /__social/act {actor,target,action} ──
  //  action ∈ request | accept | decline | cancel | remove | block | unblock
  //  All edges are kept consistent on BOTH sides of the relationship.
  if (url === '/__social/act' && req.method === 'POST') {
    try {
      const body   = await parseBody(req);
      const actor  = (body.actor||'').toUpperCase();
      const target = (body.target||'').toUpperCase();
      const action = body.action;
      if (!actor || !target || !action) { res.writeHead(400); res.end('Bad request'); return; }
      if (actor === target) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'Cannot target yourself'})); return; }
      const A = getSocial(actor), T = getSocial(target);
      const exists = !!ACCT.accounts[target];
      switch (action) {
        case 'request':
          if (!exists)  { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:false,error:'NO SUCH PLAYER'})); return; }
          if (A.friends.includes(target)) break;        // already friends
          if (T.blocked.includes(actor))  break;        // they blocked you — swallow silently
          if (A.blocked.includes(target)) break;        // you blocked them — unblock first
          if (A.incoming.includes(target)) {            // they already asked you → mutual accept
            _pull(A.incoming,target); _pull(T.outgoing,actor);
            _push(A.friends,target);  _push(T.friends,actor);
          } else { _push(A.outgoing,target); _push(T.incoming,actor); }
          break;
        case 'accept':
          if (!A.incoming.includes(target)) break;
          _pull(A.incoming,target); _pull(T.outgoing,actor);
          _push(A.friends,target);  _push(T.friends,actor);
          break;
        case 'decline': _pull(A.incoming,target); _pull(T.outgoing,actor); break;
        case 'cancel':  _pull(A.outgoing,target); _pull(T.incoming,actor); break;
        case 'remove':  _pull(A.friends,target);  _pull(T.friends,actor);  break;
        case 'block':
          _push(A.blocked,target);
          _pull(A.friends,target);  _pull(T.friends,actor);
          _pull(A.incoming,target); _pull(A.outgoing,target);
          _pull(T.incoming,actor);  _pull(T.outgoing,actor);
          break;
        case 'unblock': _pull(A.blocked,target); break;
        default: res.writeHead(400); res.end('Unknown action'); return;
      }
      saveAccts();
      console.log('  [social] '+actor+' '+action+' '+target);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, social:{ friends:[...A.friends], blocked:[...A.blocked], incoming:[...A.incoming], outgoing:[...A.outgoing], invites:[...A.invites] } }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // ── Social: invite ── POST /__social/invite {from,to,type} ──
  if (url === '/__social/invite' && req.method === 'POST') {
    try {
      const { from, to, type } = await parseBody(req);
      if (!from || !to || !type) { res.writeHead(400); res.end('Bad request'); return; }
      const T = getSocial(to);
      if (!T.blocked.includes(from.toUpperCase())) { T.invites.push({ from:from.toUpperCase(), type, ts:Date.now() }); saveAccts(); }
      console.log('  [social] invite: '+from.toUpperCase()+' -> '+to.toUpperCase()+' ('+type+')');
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:true }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // ── Social: respond to invite (remove it) ── POST /__social/invite/respond {name,index} ──
  if (url === '/__social/invite/respond' && req.method === 'POST') {
    try {
      const { name, index } = await parseBody(req);
      const S = getSocial(name);
      if (typeof index === 'number' && index>=0 && index<S.invites.length) { S.invites.splice(index,1); saveAccts(); }
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:true }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // ── Social: poll (DEPRECATED) — graph is authoritative via /__social/get now ──
  if (url.startsWith('/__social/poll')) {
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({ requests:[], invites:[], accepted:[], removed:[] }));
    return;
  }

  // ── Whisper: send ── POST /__whisper/send {from,to,text,ts} ──
  if (url === '/__whisper/send' && req.method === 'POST') {
    try {
      const { from, to, text } = await parseBody(req);
      if (!from || !to || !text) { res.writeHead(400); res.end('Bad request'); return; }
      const F = from.toUpperCase(), key = to.toUpperCase();
      // Block enforcement: drop silently if either side has blocked the other.
      if (getSocial(key).blocked.includes(F) || getSocial(F).blocked.includes(key)) {
        res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:true, blocked:true })); return;
      }
      const wmsg = { from:F, to:key, text:String(text).slice(0,500), ts:Date.now() };
      const tA = whisperThread(F, key); tA.push(wmsg); if (tA.length>WHISPER_CAP) tA.splice(0, tA.length-WHISPER_CAP);
      const tB = whisperThread(key, F); tB.push(wmsg); if (tB.length>WHISPER_CAP) tB.splice(0, tB.length-WHISPER_CAP);
      if (!whisperQueue[key]) whisperQueue[key] = [];
      whisperQueue[key].push(wmsg); // live delivery/toast on recipient's next poll
      saveAccts(); saveQueues();
      console.log('  [whisper] '+F+' -> '+key+': '+String(text).slice(0,40));
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:true }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // ── Whisper: poll new (live delivery) ── GET /__whisper/poll?name=RAVEN ──
  if (url.startsWith('/__whisper/poll')) {
    const name = (new URL(req.url, 'http://localhost').searchParams.get('name') || '').toUpperCase();
    const msgs = whisperQueue[name] ? [...whisperQueue[name]] : [];
    if (msgs.length) { whisperQueue[name] = []; saveQueues(); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(msgs));
    return;
  }

  // ── Whisper: full persisted threads ── GET /__whisper/threads?name=RAVEN ──
  if (url.startsWith('/__whisper/threads')) {
    const name = (new URL(req.url, 'http://localhost').searchParams.get('name') || '').toUpperCase();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ACCT.whispers[name] || {}));
    return;
  }


// ── AUCTION HOUSE ─────────────────────────────────────────────
// Listings persist to mythbound_ah.json — survives server restarts.
// Expired listings are cleaned on every load and every purchase.
// Buyers receive items via system mail (green). Sellers receive coins on sale.
// No in-memory state that can be lost — file is the source of truth.

const AH_FILE = path.join(ROOT, 'mythbound_ah.json');

function loadAH() {
  try {
    if (fs.existsSync(AH_FILE)) return JSON.parse(fs.readFileSync(AH_FILE, 'utf8'));
  } catch(e) { console.error('[AH] load failed:', e.message); }
  return { listings: [] };
}

function saveAH(data) {
  try {
    const tmp = AH_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, AH_FILE);
  } catch(e) { console.error('[AH] save failed:', e.message); }
}

function cleanExpired(data) {
  const now = Date.now();
  const before = data.listings.length;
  data.listings = data.listings.filter(l => l.status !== 'active' || l.expires > now);
  // Mark expired ones (keep for seller refund mail — handled on next seller poll)
  // For simplicity: just remove them. In production: queue expired refunds.
  if (data.listings.length !== before) saveAH(data);
  return data;
}

// AH SSE clients — push updates to all open AH pages instantly
const ahClients = [];
function broadcastAH(event, payload) {
  const msg = 'data: ' + JSON.stringify({ event, payload }) + '\n\n';
  ahClients.forEach((res, i) => {
    try { res.write(msg); } catch(e) { ahClients.splice(i, 1); }
  });
}

// Get a human-readable item name from the data file for mail subjects
function getItemName(itemId) {
  try {
    if (fs.existsSync(path.join(ROOT, 'mythbound_data.json'))) {
      const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'mythbound_data.json'),'utf8'));
      return (data.items && data.items[itemId] && data.items[itemId].name) || itemId;
    }
  } catch(e) {}
  return itemId;
}
function queueAHMail(toName, subject, body, coins, attachments) {
  const key = toName.toUpperCase();
  // Deliver straight into the player's server mailbox (single source of truth).
  if (!ACCT.mail[key]) ACCT.mail[key] = [];
  ACCT.mail[key].unshift({
    id: 'ah_' + Date.now() + '_' + Math.random().toString(36).slice(2),
    from: 'AUCTION HOUSE',
    to:   key,
    subject,
    body,
    type:        'ah',
    coins:       coins || 0,
    attachments: attachments || [],
    sent_at:     Date.now(),
    arrives_at:  Date.now(),
    read:        false,
    taken:       false,
    takenItems:  {},
    coinsTaken:  false,
    deleted:     false,
  });
  saveAccts();
}


  // ── AH: SSE stream ── GET /__ah/stream ──
  if (url === '/__ah/stream') {
    res.writeHead(200, {'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
    res.write(':\n\n');
    ahClients.push(res);
    // Send current active listings on connect
    const ahData = cleanExpired(loadAH());
    const active = ahData.listings.filter(l => l.status === 'active');
    res.write('data: ' + JSON.stringify({event:'init', payload: active}) + '\n\n');
    const ping = setInterval(() => { try { res.write(':\n\n'); } catch(e) { clearInterval(ping); } }, 20000);
    req.on('close', () => { clearInterval(ping); const i = ahClients.indexOf(res); if (i !== -1) ahClients.splice(i, 1); });
    return;
  }

  // ── AH: get listings ── GET /__ah/listings ──
  if (url.startsWith('/__ah/listings')) {
    const ahData = cleanExpired(loadAH());
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify(ahData.listings.filter(l => l.status === 'active')));
    return;
  }

  // ── AH: list item ── POST /__ah/list ──
  // { seller, itemId, qty, price, duration } duration in hours (12/24/48/72)
  if (url === '/__ah/list' && req.method === 'POST') {
    try {
      const { seller, itemId, qty, price, duration } = await parseBody(req);
      if (!seller || !itemId || !qty || !price) { res.writeHead(400); res.end('Missing fields'); return; }
      const ahData = cleanExpired(loadAH());
      const hours  = [12, 24, 48, 72].includes(Number(duration)) ? Number(duration) : 48;
      const fee    = Math.floor(price * 0.05); // 5% listing fee taken upfront
      const listing = {
        id:        'ah_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        seller:    seller.toUpperCase(),
        itemId:    String(itemId),
        qty:       Math.max(1, Number(qty)),
        price:     Math.max(1, Number(price)),
        fee,
        duration:  hours,
        listed_at: Date.now(),
        expires:   Date.now() + hours * 3600 * 1000,
        status:    'active',
      };
      // Dedup: same seller, same item, same price already active
      const dup = ahData.listings.find(l =>
        l.status==='active' && l.seller===listing.seller &&
        l.itemId===listing.itemId && l.qty===listing.qty && l.price===listing.price
      );
      if (dup) { res.writeHead(409); res.end('Duplicate listing'); return; }
      ahData.listings.push(listing);
      saveAH(ahData);
      broadcastAH('listed', listing);
      console.log('  [AH] listed:', listing.seller, listing.itemId, 'x'+listing.qty, 'for', listing.price);
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true, listing }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // ── AH: buy listing ── POST /__ah/buy ──
  // { buyer, listingId }
  if (url === '/__ah/buy' && req.method === 'POST') {
    try {
      const { buyer, listingId } = await parseBody(req);
      if (!buyer || !listingId) { res.writeHead(400); res.end('Missing fields'); return; }
      const ahData = cleanExpired(loadAH());
      const idx = ahData.listings.findIndex(l => l.id === listingId && l.status === 'active');
      if (idx === -1) { res.writeHead(404); res.end('Listing not found or already sold'); return; }
      const listing = ahData.listings[idx];
      if (listing.seller === buyer.toUpperCase()) { res.writeHead(400); res.end('Cannot buy your own listing'); return; }
      if (listing.expires < Date.now()) { res.writeHead(410); res.end('Listing expired'); return; }
      // Mark sold
      listing.status   = 'sold';
      listing.buyer    = buyer.toUpperCase();
      listing.sold_at  = Date.now();
      saveAH(ahData);
      // Mail item to buyer (green AH mail, instant)
      queueAHMail(buyer, 'Purchase: ' + getItemName(listing.itemId),
        'Your auction purchase has arrived!\n\n' + listing.qty + 'x ' + getItemName(listing.itemId) + ' purchased from ' + listing.seller + ' for ' + listing.price.toLocaleString() + ' \uD83E\uDE99.\n\n\u2014 Auction House',
        0, [{ itemId: listing.itemId, qty: listing.qty }]
      );
      // Mail coins to seller (minus fee already collected)
      const sellerCoins = listing.price - listing.fee;
      queueAHMail(listing.seller, getItemName(listing.itemId) + ' sold!',
        listing.qty + 'x ' + getItemName(listing.itemId) + ' sold to ' + listing.buyer + ' for ' + listing.price.toLocaleString() + ' \uD83E\uDE99.\nListing fee: ' + listing.fee + ' \uD83E\uDE99\nNet: ' + sellerCoins + ' \uD83E\uDE99\n\n\u2014 Auction House',
        sellerCoins, []
      );
      broadcastAH('sold', { id: listingId, buyer: listing.buyer });
      console.log('  [AH] sold:', listing.itemId, 'x'+listing.qty, listing.seller, '->', listing.buyer, 'for', listing.price);
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // ── AH: cancel listing ── POST /__ah/cancel ──
  // { seller, listingId }
  if (url === '/__ah/cancel' && req.method === 'POST') {
    try {
      const { seller, listingId } = await parseBody(req);
      const ahData = cleanExpired(loadAH());
      const idx = ahData.listings.findIndex(l => l.id === listingId && l.seller === seller.toUpperCase() && l.status === 'active');
      if (idx === -1) { res.writeHead(404); res.end('Listing not found'); return; }
      const listing = ahData.listings[idx];
      listing.status     = 'cancelled';
      listing.cancelled_at = Date.now();
      saveAH(ahData);
      // Return item to seller via mail
      queueAHMail(seller, 'Cancelled: ' + getItemName(listing.itemId),
        'Your listing for ' + listing.qty + 'x ' + getItemName(listing.itemId) + ' has been cancelled. Your item has been returned.\n\nNote: the listing fee of ' + listing.fee + ' \uD83E\uDE99 is not refunded.\n\n\u2014 Auction House',
        0, [{ itemId: listing.itemId, qty: listing.qty }]
      );
      broadcastAH('cancelled', { id: listingId });
      console.log('  [AH] cancelled:', listing.seller, listing.itemId);
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok: true }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // ── AH: mail poll ── GET /__ah/mail/poll?name=RAVEN ── (DEPRECATED)
  //  AH mail now lands directly in the server mailbox (see queueAHMail),
  //  so this returns nothing. Kept for backward-compat with older AH pages.
  if (url.startsWith('/__ah/mail/poll')) {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify([]));
    return;
  }

  // ── AH: my listings ── GET /__ah/mine?seller=RAVEN ──
  if (url.startsWith('/__ah/mine')) {
    const seller = (new URL(req.url, 'http://localhost').searchParams.get('seller')||'').toUpperCase();
    const ahData = cleanExpired(loadAH());
    const mine = ahData.listings.filter(l => l.seller === seller && l.status === 'active');
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify(mine));
    return;
  }

  // ── Presence: heartbeat ── POST /__presence/ping ──
  // { name, em, page, myth, level, role }
  if (url === '/__presence/ping' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      if (!body.name) { res.writeHead(400); res.end('name required'); return; }
      const key = body.name.toUpperCase();
      presenceMap[key] = { name:key, em:body.em||'?', page:body.page||'hub',
        myth:body.myth||null, level:body.level||1, role:body.role||'Adventurer',
        ts: Date.now() };
      saveQueues();
      // Single-session enforcement: if a token is supplied and it is NOT the
      // active one for this account, this client has been replaced by a newer login.
      let sessionOk = true;
      if (body.token !== undefined && ACCT.accounts[key]) sessionOk = sessionValid(key, body.token);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessionValid: sessionOk }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }


  // ── Presence: leave ── POST /__presence/leave ──
  if (url === '/__presence/leave' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const key = (body.name||'').toUpperCase();
      if (key && presenceMap[key]) {
        delete presenceMap[key];
        saveQueues();
        console.log('  [presence] left:', key, '— total online:', Object.keys(presenceMap).length);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // ── Presence: list ── GET /__presence/list ──
  if (url === '/__presence/list') {
    // Players active within last 30s
    const now = Date.now();
    const active = Object.values(presenceMap).filter(p => now - p.ts < 60000);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(active));
    return;
  }

  // ════════════════════════════════════════════════════════════
  //  ACCOUNT / SESSION / PLAYER-SAVE / MAIL ROUTES
  // ════════════════════════════════════════════════════════════

  // ── Register ── POST /__account/register {username,email,password,em}
  if (url === '/__account/register' && req.method === 'POST') {
    try {
      const { username, email, password, em } = await parseBody(req);
      if (!username || username.length < 3) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'USERNAME TOO SHORT (MIN 3)'})); return; }
      if (!password || password.length < 6) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'PASSWORD TOO SHORT (MIN 6)'})); return; }
      const key = username.toUpperCase();
      if (ACCT.accounts[key]) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'USERNAME ALREADY TAKEN'})); return; }
      const acc = buildAccount({ name:username, em, email, password });
      ACCT.accounts[key] = acc;
      ACCT.saves[key]    = starterSave(acc);
      ACCT.mail[key]     = seedMailbox(key);
      const token = newToken();
      ACCT.sessions[key] = { token, ts: Date.now() };
      saveAcctsNow();
      console.log('  [acct] registered:', key);
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, user:publicUser(acc), token, save:ACCT.saves[key], mail:ACCT.mail[key] }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // ── Login ── POST /__account/login {username,password}
  if (url === '/__account/login' && req.method === 'POST') {
    try {
      const { username, password } = await parseBody(req);
      const key = (username||'').toUpperCase();
      const acc = ACCT.accounts[key];
      if (!acc)                      { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'ACCOUNT NOT FOUND'})); return; }
      if (acc.password !== password) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'INCORRECT PASSWORD'})); return; }
      const token = newToken(); // new token kicks any prior session
      ACCT.sessions[key] = { token, ts: Date.now() };
      if (!ACCT.saves[key]) ACCT.saves[key] = starterSave(acc);
      if (!ACCT.mail[key])  ACCT.mail[key]  = seedMailbox(key);
      saveAcctsNow();
      console.log('  [acct] login:', key, '(prior session, if any, kicked)');
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, user:publicUser(acc), token, save:ACCT.saves[key], mail:ACCT.mail[key] }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // ── Logout ── POST /__account/logout {name,token}
  if (url === '/__account/logout' && req.method === 'POST') {
    try {
      const { name, token } = await parseBody(req);
      const key = (name||'').toUpperCase();
      const s = ACCT.sessions[key];
      if (s && s.token === token) { delete ACCT.sessions[key]; saveAccts(); console.log('  [acct] logout:', key); }
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:true }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // ── Import (one-time migration of pre-server accounts) ── POST /__account/import {account,save}
  if (url === '/__account/import' && req.method === 'POST') {
    try {
      const { account, save } = await parseBody(req);
      if (!account || !account.name) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'NO ACCOUNT'})); return; }
      const key = account.name.toUpperCase();
      if (ACCT.accounts[key]) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true,imported:false})); return; }
      const acc = buildAccount({ name:account.name, em:account.em, email:account.email, password:account.password, role:account.role, myth:account.myth, level:account.level });
      ACCT.accounts[key] = acc;
      ACCT.saves[key]    = save || starterSave(acc);
      if (!ACCT.mail[key]) ACCT.mail[key] = seedMailbox(key);
      saveAcctsNow();
      console.log('  [acct] imported legacy account:', key);
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:true, imported:true }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // ── Sync/validate ── GET /__account/sync?name=&token=
  //  Returns latest save+mail and whether this token is still the active session.
  if (url.startsWith('/__account/sync')) {
    const q = new URL(req.url,'http://localhost').searchParams;
    const key = (q.get('name')||'').toUpperCase();
    const token = q.get('token')||'';
    const acc = ACCT.accounts[key];
    res.writeHead(200,{'Content-Type':'application/json'});
    if (!acc) { res.end(JSON.stringify({ ok:false, exists:false })); return; }
    res.end(JSON.stringify({
      ok:true, valid:sessionValid(key,token),
      user:publicUser(acc), save:ACCT.saves[key]||null, mail:ACCT.mail[key]||[],
    }));
    return;
  }

  // ── Save player ── POST /__player/save {name,token,player}
  if (url === '/__player/save' && req.method === 'POST') {
    try {
      const { name, token, player } = await parseBody(req);
      const key = (name||'').toUpperCase();
      if (!sessionValid(key, token)) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, valid:false })); return; }
      if (!player || typeof player !== 'object') { res.writeHead(400); res.end('no player'); return; }
      ACCT.saves[key] = player;
      ACCT.sessions[key].ts = Date.now();
      saveAccts();
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:true, valid:true }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // ── Load player ── GET /__player/load?name=
  if (url.startsWith('/__player/load')) {
    const key = (new URL(req.url,'http://localhost').searchParams.get('name')||'').toUpperCase();
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(ACCT.saves[key]||null));
    return;
  }

  // ── Mail: list ── GET /__mail/list?name=
  if (url.startsWith('/__mail/list')) {
    const key = (new URL(req.url,'http://localhost').searchParams.get('name')||'').toUpperCase();
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(ACCT.mail[key]||[]));
    return;
  }

  // ── Mail: send/deliver ── POST /__mail/send {to, mail}
  if (url === '/__mail/send' && req.method === 'POST') {
    try {
      const { to, mail } = await parseBody(req);
      const key = (to||'').toUpperCase();
      if (!key)            { res.writeHead(400); res.end('no recipient'); return; }
      if (!ACCT.accounts[key]) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, error:'NO SUCH PLAYER' })); return; }
      if (!ACCT.mail[key]) ACCT.mail[key] = [];
      const m = Object.assign({
        id:'m_'+Date.now()+'_'+Math.random().toString(36).slice(2,7),
        to:key, type:'player', coins:0, attachments:[],
        sent_at:Date.now(), arrives_at:Date.now(),
        read:false, taken:false, takenItems:{}, coinsTaken:false, deleted:false,
      }, mail||{});
      m.to = key;
      ACCT.mail[key].unshift(m);
      saveAccts();
      console.log('  [mail] delivered to', key, '\u2014', m.subject || '(no subject)');
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:true, mail:m }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // ── Mail: save mailbox (read/taken/deleted state) ── POST /__mail/save {name,token,mail}
  //  MERGE by id: updates mails the client knows about, but never drops mails
  //  the server has that the client hasn't seen yet (e.g. mail delivered between
  //  the client's last refresh and this save). Deletes are soft (deleted:true).
  if (url === '/__mail/save' && req.method === 'POST') {
    try {
      const { name, token, mail } = await parseBody(req);
      const key = (name||'').toUpperCase();
      if (!sessionValid(key, token)) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, valid:false })); return; }
      if (!Array.isArray(mail)) { res.writeHead(400); res.end('bad mail'); return; }
      const server = ACCT.mail[key] || [];
      const byId = {};
      server.forEach(m => { byId[m.id] = m; });
      mail.forEach(m => { if (!m || !m.id) return; byId[m.id] = byId[m.id] ? Object.assign(byId[m.id], m) : m; });
      // Preserve original ordering: client order first, then any server-only mails on top.
      const seen = new Set(mail.map(m => m && m.id));
      const serverOnly = server.filter(m => !seen.has(m.id)).map(m => byId[m.id]);
      ACCT.mail[key] = serverOnly.concat(mail.map(m => byId[m.id]).filter(Boolean));
      saveAccts();
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:true, valid:true }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // ════════════════════════════════════════════════════════════
  //  TRADING ROUTES
  // ════════════════════════════════════════════════════════════

  // ── Open a trade ── POST /__trade/open {from,to}
  if (url === '/__trade/open' && req.method === 'POST') {
    try {
      const { from, to } = await parseBody(req);
      const A = (from||'').toUpperCase(), B = (to||'').toUpperCase();
      if (!A || !B || A === B) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, error:'Invalid trade.' })); return; }
      if (!ACCT.accounts[B]) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, error:'NO SUCH PLAYER' })); return; }
      if (getSocial(B).blocked.includes(A) || getSocial(A).blocked.includes(B)) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, error:'Trading is blocked between you two.' })); return; }
      if (activeTradeFor(A) || activeTradeFor(B)) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, error:'One of you is already in a trade.' })); return; }
      const id = newTradeId();
      TRADES[id] = { id, status:'open', updated:Date.now(),
        a:{ name:A, offer:[], coins:0, confirmed:false },
        b:{ name:B, offer:[], coins:0, confirmed:false } };
      console.log('  [trade] opened', A, '<->', B);
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:true, trade:tradePublic(TRADES[id]) }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // ── Poll trade state ── GET /__trade/state?name=  OR  ?id=
  if (url.startsWith('/__trade/state')) {
    const q = new URL(req.url,'http://localhost').searchParams;
    let t = null;
    if (q.get('id')) t = TRADES[q.get('id')];
    else if (q.get('name')) t = reportableTradeFor(q.get('name'));
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify(t ? { ok:true, trade:tradePublic(t) } : { ok:true, trade:null }));
    return;
  }

  // ── Update an offer ── POST /__trade/offer {id,name,items,coins}
  //  Changing an offer un-confirms BOTH sides (standard trade-window behaviour).
  if (url === '/__trade/offer' && req.method === 'POST') {
    try {
      const { id, name, items, coins } = await parseBody(req);
      const t = TRADES[id];
      if (!t || t.status !== 'open') { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, error:'Trade not open.' })); return; }
      const side = tradeSide(t, name);
      if (!side) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, error:'Not your trade.' })); return; }
      side.offer = sanitizeOffer(items);
      side.coins = Math.max(0, Math.floor(Number(coins)||0));
      t.a.confirmed = false; t.b.confirmed = false;
      t.updated = Date.now();
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:true, trade:tradePublic(t) }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // ── Confirm ── POST /__trade/confirm {id,name}
  if (url === '/__trade/confirm' && req.method === 'POST') {
    try {
      const { id, name } = await parseBody(req);
      const t = TRADES[id];
      if (!t || t.status !== 'open') { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, error:'Trade not open.' })); return; }
      const side = tradeSide(t, name);
      if (!side) { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:false, error:'Not your trade.' })); return; }
      side.confirmed = true;
      t.updated = Date.now();
      if (t.a.confirmed && t.b.confirmed) {
        executeTrade(t);                 // atomic swap (sets status complete/cancelled)
        t.ended = Date.now();
        console.log('  [trade] '+t.id+' -> '+t.status+(t.error?' ('+t.error+')':''));
      }
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:true, trade:tradePublic(t) }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // ── Cancel ── POST /__trade/cancel {id,name}
  if (url === '/__trade/cancel' && req.method === 'POST') {
    try {
      const { id, name } = await parseBody(req);
      const t = TRADES[id];
      if (t && t.status === 'open') { t.status='cancelled'; t.error=(name||'').toUpperCase()+' cancelled the trade.'; t.ended=Date.now(); t.updated=Date.now(); }
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:true, trade:t?tradePublic(t):null }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // ── Static files ──
  let filePath = url === '/' ? path.join(ROOT, 'mythbound_hub.html') : path.join(ROOT, url);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found: ' + url); return; }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    if (ext === '.html') {
      const html = data.toString().replace('</body>', RELOAD_SNIPPET + '\n</body>');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } else {
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    }
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log('');
  console.log('  ╔════════════════════════════════════╗');
  console.log('  ║   MYTHBOUND dev server running     ║');
  console.log('  ║   http://localhost:' + PORT + '             ║');
  console.log('  ╚════════════════════════════════════╝');
  console.log('');
  console.log('  Chat sync: ws-free SSE broadcast active');
  console.log('  Watching for file changes...');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
