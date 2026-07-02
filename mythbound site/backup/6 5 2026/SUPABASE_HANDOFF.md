# MYTHBOUND — Supabase Migration Handoff
# For Claude in a future conversation when this chat is too long to continue.
# Read this entire document before touching any code.

---

## WHO YOU ARE / WHAT THIS PROJECT IS

You are continuing development of **MYTHBOUND** — a browser-based RPG with:
- Chat hub with clan channels
- Fishing minigame (multiplayer-capable, invite to pond)
- Mining minigame (pixel rock-breaking, combat, loot drops)
- ATB battle system (FF7-style)
- Inventory with equipment slots, rarity system, bag upgrades
- Games navigator page
- Admin/minigames config panel

Stack: **pure HTML/JS/CSS files** — no framework, no bundler. Served locally via
`node server.js` (zero npm dependencies). Production target: **Netlify** (static
host) + **Supabase** (auth, database, realtime).

The developer is **Raven** — solo dev, non-technical background, learns fast.
Keep explanations grounded. Never remake whole files for small changes — patch only
what needs changing. Never use font sizes below 12px. Never make mockups without
permission.

---

## FILE STRUCTURE

All files live in one flat folder:

```
mythbound/
├── server.js                      ← local dev server, zero npm deps, node server.js
├── mythbound_shared.js            ← THE BRAIN — all shared data, persistence, nav
├── mythbound_hub.html             ← chat hub, clan channels, admin panel
├── mythbound_games.html           ← game navigator/launcher
├── mythbound_fishing_lobby.html   ← fishing minigame (solo + invite multiplayer)
├── mythbound_mining.html          ← mining minigame
├── mythbound_battle.html          ← ATB battle system
├── mythbound_inventory.html       ← inventory, equipment, bag
└── mythbound_admin_minigames.html ← admin config panel (fishing/mining FC object)
```

`mythbound_fishing.html` (solo-only version) is **shelved** — do not use it.
Only `mythbound_fishing_lobby.html` is maintained going forward.

---

## THE SHARED DATA LAYER (mythbound_shared.js)

Every page imports this first: `<script src="mythbound_shared.js"></script>`

Key objects on the global `MB` namespace:

```
MB.PLAYER          — canonical player state (coins, energy, professions, bag, equipped)
MB.RC              — rarity color map (ultimate = null, uses CSS animation)
MB.RORD            — rarity sort order {common:0 ... ultimate:5}
MB.ITEMS           — master item database (id → item definition)
MB.FC              — fishing config (also edited live by admin panel)
MB.PICKAXES        — mining pickaxe definitions
MB.ROCKS           — mining rock/enemy definitions
MB.ECONOMY         — XP table, drop rate bonuses, profession unlock gates
MB.PAGES           — page router map {hub, games, fishing, mining, battle, inventory, admin}
MB.nav(page)       — navigates to a page by key
MB.renderNav(id, currentPage) — renders nav buttons into any element by id
MB.injectUltimateCSS()        — injects rainbow animation CSS (call once per page)
```

### Persistence helpers (THE MIGRATION SURFACE — read carefully):

```js
MB.savePlayer()           // writes MB.PLAYER to localStorage
MB.loadPlayer()           // reads localStorage into MB.PLAYER (called on script load)
MB.addToInventory(id, qty) // adds item to MB.PLAYER.bag + saves
MB.removeFromInventory(id, qty)
MB.addXP(profession, amount)  // handles level-up logic + saves
MB.setEnergy(val)             // clamps + saves
MB.addCoins(amount)           // adds/subtracts + saves
MB.resetSave()                // wipes localStorage + reloads (debug)
MB.SAVE_KEY = 'mythbound_player_v1'
```

**THESE ARE THE ONLY FUNCTIONS YOU REPLACE FOR SUPABASE.**
Everything else in every page already calls these. The migration is entirely
contained to the bodies of these functions in `mythbound_shared.js`.

---

## CURRENT PERSISTENCE: localStorage

`MB.PLAYER` is a plain JS object. On load, `MB.loadPlayer()` reads it from
`localStorage['mythbound_player_v1']` as JSON. On any change, `MB.savePlayer()`
writes it back. This works per-browser, not per-account.

What IS saved right now:
- coins, energy, energyMax
- professions (level, xp, xpMax for fishing/mining/herbalism/hunting)
- craft, craftLevel, craftXp
- bag (array of item objects with qty)
- equipped (slot → item object)
- bagSlots, slotsUnlocked, lockedSlots

What is NOT saved yet (future work):
- Fishing session loot (fish caught)
- Battle state
- Clan memberships


---

## DATA ARCHITECTURE (added after mockup phase)

### mythbound_data.json
Single source of truth for all editable game data. Lives in the project folder.
Server serves it at GET /__data, saves it at POST /__data.
DO NOT hardcode game values in shared.js or HTML pages — they belong here.

Structure:
- items: all 69+ items with full definitions
- miningRocks: rock tier table with drop tables
- miningEnemies: enemy definitions
- pickaxes: pickaxe tiers
- economy: flat config values
- myths: all 10 myth definitions
- roles: role permission definitions
- chat.channels: channel list

### Shared.js data flow
1. MB.loadGameData() fetches /__data and merges into MB.ITEMS, MB.ROCKS etc
2. MB.gameDataReady is the Promise — pages await it before rendering
3. MB.onReady(cb) — convenience wrapper: waits for data then calls cb
4. MB.hydrateItem(saved) — merges a saved {id,qty} with current MB.ITEMS def
5. MB.hydratePlayer() — re-hydrates entire bag/equipped from MB.ITEMS

### Bag storage rule
MB.PLAYER.bag items store ONLY {id, qty}. Never store full item definitions.
All fields (name, rarity, sell, stats etc) are always read from MB.ITEMS at render time.
This ensures data editor changes take effect immediately without clearing save data.

### Admin data editor
URL: mythbound_admin_data.html
Access: Admin panel → DATA EDITOR button
Edits: items, rocks, enemies, economy, myths, roles
Save: writes to mythbound_data.json via POST /__data
After save: MB.loadGameData() re-runs, MB.hydratePlayer() updates current session

### When starting a new Claude session
Upload mythbound_data.json alongside SUPABASE_HANDOFF.md.
Claude reads the data file — no overwrites of your customizations.
Claude only touches shared.js logic/structure, never mythbound_data.json directly.

---

## SUPABASE MIGRATION — STEP BY STEP

### Step 1: Supabase project setup
1. Create project at supabase.com (free tier is fine)
2. Copy your `Project URL` and `anon public key` from Settings → API
3. Add the Supabase JS client to `mythbound_shared.js` head:
   ```html
   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
   ```
   Add this to the TOP of `mythbound_shared.js` before anything else:
   ```js
   const _SB = supabase.createClient('YOUR_PROJECT_URL', 'YOUR_ANON_KEY');
   ```

### Step 2: Database schema
Run this SQL in Supabase → SQL Editor:

```sql
-- Players table
create table players (
  id uuid references auth.users primary key,
  name text not null,
  em text default '🐦‍⬛',
  coins integer default 0,
  energy integer default 1000,
  energy_max integer default 1000,
  level integer default 1,
  role text default 'Striker',
  myth text,
  craft text,
  craft_level integer default 1,
  craft_xp integer default 0,
  bag_slots integer default 20,
  slots_unlocked integer default 0,
  created_at timestamptz default now()
);

-- Professions (separate table for clean level tracking)
create table player_professions (
  id uuid default gen_random_uuid() primary key,
  player_id uuid references players(id) on delete cascade,
  profession text not null,  -- 'fishing','mining','herbalism','hunting'
  level integer default 1,
  xp integer default 0,
  xp_max integer default 100,
  unique(player_id, profession)
);

-- Inventory
create table player_inventory (
  id uuid default gen_random_uuid() primary key,
  player_id uuid references players(id) on delete cascade,
  item_id text not null,     -- matches MB.ITEMS key
  qty integer default 1,
  unique(player_id, item_id)
);

-- Equipped items
create table player_equipped (
  id uuid default gen_random_uuid() primary key,
  player_id uuid references players(id) on delete cascade,
  slot text not null,        -- 'helm','chest','main','off','ring','boots','legs','trinket','myth'
  item_id text not null,
  unique(player_id, slot)
);

-- Row Level Security (players can only read/write their own data)
alter table players enable row level security;
alter table player_professions enable row level security;
alter table player_inventory enable row level security;
alter table player_equipped enable row level security;

create policy "own data" on players for all using (auth.uid() = id);
create policy "own data" on player_professions for all using (auth.uid() = player_id);
create policy "own data" on player_inventory for all using (auth.uid() = player_id);
create policy "own data" on player_equipped for all using (auth.uid() = player_id);
```

### Step 3: Auth
Supabase handles auth. Add a login page (`mythbound_login.html`) with:
```js
// Sign up
const { data, error } = await _SB.auth.signUp({ email, password });
// Sign in
const { data, error } = await _SB.auth.signInWithPassword({ email, password });
// Get current user
const { data: { user } } = await _SB.auth.getUser();
// Sign out
await _SB.auth.signOut();
```

After login, store `user.id` as `MB.PLAYER.id` and load their data.

### Step 4: Replace persistence functions

In `mythbound_shared.js`, replace the bodies of these functions.
**Do not change their signatures or remove them — pages call them directly.**

```js
// REPLACE MB.savePlayer:
MB.savePlayer = async function() {
  const uid = MB.PLAYER.id;
  if (!uid) return;
  await _SB.from('players').upsert({
    id: uid,
    name: MB.PLAYER.name,
    em: MB.PLAYER.em,
    coins: MB.PLAYER.coins,
    energy: MB.PLAYER.energy,
    energy_max: MB.PLAYER.energyMax,
    level: MB.PLAYER.level,
    role: MB.PLAYER.role,
    myth: MB.PLAYER.myth,
    craft: MB.PLAYER.craft,
    craft_level: MB.PLAYER.craftLevel,
    craft_xp: MB.PLAYER.craftXp,
    bag_slots: MB.PLAYER.bagSlots,
    slots_unlocked: MB.PLAYER.slotsUnlocked,
  });
  // Save professions
  for (const [prof, data] of Object.entries(MB.PLAYER.professions)) {
    await _SB.from('player_professions').upsert({
      player_id: uid, profession: prof,
      level: data.level, xp: data.xp, xp_max: data.xpMax
    }, { onConflict: 'player_id,profession' });
  }
};

// REPLACE MB.loadPlayer:
MB.loadPlayer = async function() {
  const { data: { user } } = await _SB.auth.getUser();
  if (!user) { window.location.href = 'mythbound_login.html'; return; }
  MB.PLAYER.id = user.id;

  const { data: player } = await _SB.from('players').select('*').eq('id', user.id).single();
  if (player) {
    MB.PLAYER.name = player.name;
    MB.PLAYER.em = player.em;
    MB.PLAYER.coins = player.coins;
    MB.PLAYER.energy = player.energy;
    MB.PLAYER.energyMax = player.energy_max;
    MB.PLAYER.level = player.level;
    MB.PLAYER.role = player.role;
    MB.PLAYER.myth = player.myth;
    MB.PLAYER.craft = player.craft;
    MB.PLAYER.craftLevel = player.craft_level;
    MB.PLAYER.craftXp = player.craft_xp;
    MB.PLAYER.bagSlots = player.bag_slots;
    MB.PLAYER.slotsUnlocked = player.slots_unlocked;
  }

  const { data: profs } = await _SB.from('player_professions').select('*').eq('player_id', user.id);
  if (profs) profs.forEach(p => {
    if (MB.PLAYER.professions[p.profession]) {
      MB.PLAYER.professions[p.profession] = { level: p.level, xp: p.xp, xpMax: p.xp_max };
    }
  });
};

// REPLACE MB.addToInventory:
MB.addToInventory = async function(itemId, qty) {
  qty = qty || 1;
  const uid = MB.PLAYER.id;
  // Update local state
  if (!MB.PLAYER.bag) MB.PLAYER.bag = [];
  const existing = MB.PLAYER.bag.find(i => i.id === itemId);
  if (existing) existing.qty = (existing.qty || 1) + qty;
  else {
    const template = MB.ITEMS[itemId];
    MB.PLAYER.bag.push(Object.assign({}, template, { id: itemId, qty }));
  }
  // Persist
  const currentQty = existing ? existing.qty : qty;
  await _SB.from('player_inventory').upsert(
    { player_id: uid, item_id: itemId, qty: currentQty },
    { onConflict: 'player_id,item_id' }
  );
};
```

### Step 5: BroadcastChannel → Supabase Realtime

The fishing lobby and admin panel use `BroadcastChannel('mythbound_config')` for
live config sync between tabs. In production, replace with Supabase Realtime:

```js
// In mythbound_fishing_lobby.html and mythbound_admin_minigames.html,
// find the BroadcastChannel setup and replace:

const channel = _SB.channel('mythbound_config')
  .on('broadcast', { event: 'fc_update' }, ({ payload }) => {
    Object.assign(FC, payload);
  })
  .subscribe();

// Admin panel broadcast:
channel.send({ type: 'broadcast', event: 'fc_update', payload: FC });
```

### Step 6: Netlify deploy
1. Remove `server.js` from the folder (or just don't upload it)
2. Drag the folder to netlify.com → drop zone
3. Set environment — Supabase URL and key are in the JS source (anon key is safe to expose)
4. Done — Netlify gives you a free `*.netlify.app` URL

---

## RARITY SYSTEM

Six rarities in order: common → uncommon → rare → epic → legendary → ultimate

Color map (`MB.RC`):
```
common:    '#999'
uncommon:  '#6bff9b'
rare:      '#6bb5ff'
epic:      '#c455e8'
legendary: '#ffdd6b'
ultimate:  null  ← NEVER a static hex. Always animated rainbow CSS.
```

**Ultimate rarity** uses `MB.injectUltimateCSS()` which adds `@keyframes mb-rainbow-bg`
and these classes: `.mb-ult-text` (rainbow text), `.mb-ult-border` (rainbow border wrapper),
`.mb-ult-badge` (black text on rainbow), `.mb-ult-dot`, `.item-link.ultimate`.

In inventory: item cell borders ARE the rarity color (`.ib-common`, `.ib-rare`, etc).
Ultimate cells use `.ib-ultimate` which is a padding-wrapper with rainbow background.
Equipment slots use `.rar-common`, `.rar-rare`, etc on the `.gslot` element.

Do NOT use `#cc44ff` for ultimate rarity anywhere. That was a prior mistake.
Purple (`#cc44ff`) is used for void element color and myth UI accents — unrelated to rarity.

---

## NAV BAR STANDARD

Every page has this exact nav structure:

```html
<nav>
  <div class="logo">MYTHBOUND</div>
  <div class="nav-links" id="main-nav"></div>
</nav>
```

And this exact CSS (copy verbatim, do not alter padding/border/font):
```css
nav{display:flex;align-items:center;justify-content:space-between;padding:8px 18px;border-bottom:2px solid #fff;background:#000;flex-shrink:0;}
.logo{font-family:'Press Start 2P',monospace;font-size:9px;color:#fff;}
.nav-links{display:flex;gap:5px;}
.nb{background:#000;border:2px solid #444;color:#444;padding:7px 12px;font-family:'Press Start 2P',monospace;font-size:7px;cursor:pointer;}
.nb:hover,.nb.on{border-color:#fff;color:#fff;}
.nb.wip{border-color:#222;color:#333;cursor:default;}
.nb.myth{border-color:#555;color:#555;}
```

Nav buttons are rendered by `MB.renderNav('main-nav', 'currentPageKey')`.
Hub has an extra ADMIN button to the right of main-nav inside a flex wrapper.
Do NOT add logos with icons (no ⚔ or similar) — just plain "MYTHBOUND" text.

---

## ECONOMY DESIGN (do not contradict these decisions)

- Currency: Doubloons (🪙)
- One craft profession per player. Full progress lost on switch. Cost: 500 coins.
- Gathering professions: fishing, mining, herbalism, hunting (all 1–100)
- Craft professions: blacksmithing, cooking, alchemy, leatherworking
- Professions are interdependent by design — no single player self-sufficient
- No hard daily limits on grinding — energy system gates it instead
- Energy depletes per action, regenerates slowly, restored by food/potions from other players
- Drop rates: common 65%→45%, uncommon 25%→35%, rare 9.9%→19.5%, legendary always <1%
- Legendary drops never become farmable regardless of level
- Auction house is player-to-player (no coins created/destroyed)
- NPC shop buys at 40% of item sell value to incentivize player trading
- Auction listing fee: 5% (inflation sink)

---

## THINGS TO NEVER DO

- Never use font sizes below 12px anywhere in any page
- Never remake a whole file when a targeted patch works
- Never make mockups without explicit permission
- Never use solid violet (#cc44ff) for ultimate rarity
- Never use the shelved solo fishing file (mythbound_fishing.html)
- Never add inline style= to the main-nav div (use class="nav-links")
- Never give the MYTHBOUND logo an icon/emoji prefix
- Walking avatar concept is reserved for player housing rooms only — not hub

---

## KNOWN PENDING ITEMS (as of this handoff)

- Fishing lobby: verify FC alias to MB.FC works correctly after shared.js load
- Hub clan system: clan memberships not yet persisted to localStorage/Supabase
- Fishing drops not yet wired to MB.addToInventory (mining is done, fishing is next)
- Herbalism and hunting minigames: WIP placeholders only
- mythbound_games.html WIP cards: herbalism, hunting, blacksmithing, alchemy, cooking,
  leatherworking, dungeon finder, raid finder all show 🚧
- Battle drops not yet wired to inventory
- No login/auth page yet — localStorage bridges until Supabase auth is added

