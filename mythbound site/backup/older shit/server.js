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

  // ── Social: friend request ── POST /__social/request ──
  if (url === '/__social/request' && req.method === 'POST') {
    try {
      const { from, to } = await parseBody(req);
      if (!from || !to) { res.writeHead(400); res.end('Bad request'); return; }
      const pending = getSocialPending(to);
      const fromUpper = from.toUpperCase();
      if (!pending.requests.includes(fromUpper)) {
        pending.requests.push(fromUpper);
        saveQueues(); // persist so poll delivers even across restarts
      }
      console.log('  [social] friend request: ' + fromUpper + ' -> ' + to.toUpperCase());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // ── Social: invite ── POST /__social/invite ──
  if (url === '/__social/invite' && req.method === 'POST') {
    try {
      const { from, to, type } = await parseBody(req);
      if (!from || !to || !type) { res.writeHead(400); res.end('Bad request'); return; }
      const pending = getSocialPending(to);
      pending.invites.push({ from: from.toUpperCase(), type, ts: Date.now() });
      saveQueues();
      console.log('  [social] invite: ' + from.toUpperCase() + ' -> ' + to.toUpperCase() + ' (' + type + ')');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // ── Social: poll for pending ── GET /__social/poll?name=RAVEN ──
  if (url.startsWith('/__social/poll')) {
    const name = new URL(req.url, 'http://localhost').searchParams.get('name') || '';
    const pending = getSocialPending(name);
    // Return and clear — client merges into its local SOCIAL store
    const accepted = pending.accepted ? [...pending.accepted] : [];
    const removed  = pending.removed  ? [...pending.removed]  : [];
    const result = { requests:[...pending.requests], invites:[...pending.invites], accepted, removed };
    if (result.requests.length||result.invites.length||accepted.length||removed.length) {
      pending.requests=[]; pending.invites=[]; pending.accepted=[]; pending.removed=[]; saveQueues();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }


  // ── Whisper: send ── POST /__whisper/send ──
  // { from, to, text, ts }
  if (url === '/__whisper/send' && req.method === 'POST') {
    try {
      const { from, to, text } = await parseBody(req);
      if (!from || !to || !text) { res.writeHead(400); res.end('Bad request'); return; }
      const key = to.toUpperCase();
      const wmsg = {from:from.toUpperCase(),to:key,text:String(text).slice(0,500),ts:Date.now()};
      if (!whisperQueue[key]) whisperQueue[key] = [];
      whisperQueue[key].push(wmsg);
      saveQueues();
      console.log('  [whisper] '+from.toUpperCase()+' -> '+key+': '+String(text).slice(0,40));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }

  // ── Whisper: poll ── GET /__whisper/poll?name=RAVEN ──
  if (url.startsWith('/__whisper/poll')) {
    const name = (new URL(req.url, 'http://localhost').searchParams.get('name') || '').toUpperCase();
    const msgs = whisperQueue[name] ? [...whisperQueue[name]] : [];
    if (msgs.length) { whisperQueue[name] = []; saveQueues(); } // clear + persist so restarts don't redeliver
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(msgs));
    return;
  }


  // ── Social: accept ── POST /__social/accept ──
  // Notifies the original requester that their request was accepted
  if (url === '/__social/accept' && req.method === 'POST') {
    try {
      const { from, to } = await parseBody(req); // from=accepter, to=requester
      if (!from || !to) { res.writeHead(400); res.end('Bad request'); return; }
      // Add accepter to requester's friends via their pending queue
      const pending = getSocialPending(to);
      if (!pending.accepted) pending.accepted = [];
      pending.accepted.push(from.toUpperCase());
      saveQueues();
      console.log('  [social] accepted: ' + from.toUpperCase() + ' accepted ' + to.toUpperCase());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
    return;
  }


  // ── Social: remove friend ── POST /__social/remove ──
  // Queues a removal notification so the other player's friends list updates
  if (url === '/__social/remove' && req.method === 'POST') {
    try {
      const { from, to } = await parseBody(req);
      if (!from || !to) { res.writeHead(400); res.end('Bad request'); return; }
      const pending = getSocialPending(to);
      if (!pending.removed) pending.removed = [];
      pending.removed.push(from.toUpperCase());
      saveQueues();
      console.log('  [social] remove: ' + from.toUpperCase() + ' removed ' + to.toUpperCase());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) { res.writeHead(500); res.end(e.message); }
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

// Deliver a system mail to a player (written directly to their localStorage mail key)
// Since server can't write localStorage, we queue it for client pickup via /__ah/mail/poll
const ahMailQueue = _q.ahMail || {}; // { PLAYERNAME: [mailObj, ...] } — persisted


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
  if (!ahMailQueue[key]) ahMailQueue[key] = [];
  ahMailQueue[key].push({
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
  saveQueues();
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

  // ── AH: mail poll ── GET /__ah/mail/poll?name=RAVEN ──
  // Client polls this on AH page load and after any buy/sell action
  if (url.startsWith('/__ah/mail/poll')) {
    const name = (new URL(req.url, 'http://localhost').searchParams.get('name')||'').toUpperCase();
    const mails = ahMailQueue[name] ? [...ahMailQueue[name]] : [];
    if (mails.length) { ahMailQueue[name] = []; saveQueues(); console.log('  [AH] delivering', mails.length, 'mail(s) to', name); }
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify(mails));
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
      console.log('  [presence] ping from', key, '— total online:', Object.keys(presenceMap).length);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
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
