# MYTHBOUND — Supabase Migration Handoff
**Updated handoff. Read this entire document before touching any code.**
*Previous version was written pre-combat, pre-myths. This replaces it entirely.*

---

## WHO YOU ARE / WHAT THIS PROJECT IS

You are continuing **MYTHBOUND** — a browser-based multiplayer RPG built by **Raven**, a solo developer on a SteamDeck (Konsole). Aesthetic: Runescape/WoW mechanics fused with an Undertale/Deltarune visual style. Testing always uses three browser profiles simultaneously to simulate multiple accounts.

**Stack:**
- Pure HTML/CSS/JS — no framework, no bundler, no TypeScript
- Local dev: `node server.js` → `http://localhost:3000`
- Files live at `~/Downloads/mythboundwebsite/v2/`
- Production target: **Netlify** (static) + **Supabase** (auth, DB, realtime)

Raven's workflow: replace file → `Ctrl+C` → `node server.js` → `Ctrl+Shift+R` (hard-refresh).

---

## STANDING RULES — NEVER VIOLATE THESE

1. **BACKUP RULE (critical):** If you must rebuild something from scratch, or you don't have a file relevant to a patch, **ASK Raven to upload their latest backup first**. Never rebuild from guesswork. Raven has switched AI assistants over wasted effort from ignoring this.
2. **Surgical patches only.** Never rewrite a whole file for a small change. Never break a working page when adding features.
3. **No font sizes below 12px** in any new additions or mockups. (The battle page intentionally uses tiny pixel fonts for the retro aesthetic; don't add smaller ones.)
4. **Never invent stats.** Canonical stats: `stm / agi / def / wil / atk / arc`. No STR, INT, DEX, etc.
5. **Bag storage = `{id, qty}` ONLY.** Never store hydrated objects in the bag. All hydration is read-only via `MB.getBag()`.
6. **Player identifier = `MB.PLAYER.name`** (always uppercase). Never use `account.id` (it's a meaningless `local_XXXXXX` string).
7. **Doubloons, not coins.** The currency is called doubloons in all UI text, even though the JS field is `MB.PLAYER.coins`.
8. **Deliver only changed files.** Don't bulk-copy or deliver unchanged files.
9. **Ask before editing `server.js` or `shared.js`.** They touch everything; always get the latest upload first.

---

## FILE STRUCTURE

```
v2/
├── server.js                        ← local dev server (Node, zero npm deps)
├── mythbound_shared.js              ← THE BRAIN: all MB.* helpers, loaded by every page
├── mythbound_data.json              ← game data: skills, myths, items, dungeons, statuses, etc.
├── _mythbound_accounts.json         ← server-side account store (username/hash/session)
├── _mythbound_queues.json           ← persisted whisper/social queues, presence
├── mythbound_ah.json                ← auction house listings
│
├── mythbound_auth.html              ← sign-in / create account
├── mythbound_hub.html               ← social hub, chat, presence, admin panel
├── mythbound_inventory.html         ← bag, equipment, myth binding
├── mythbound_battle.html            ← dungeon select, ATB combat engine
├── mythbound_auction.html           ← auction house
├── mythbound_mail.html              ← player mail
├── mythbound_fishing_lobby.html     ← fishing minigame (only fishing file; solo version shelved)
├── mythbound_mining.html            ← mining minigame
├── mythbound_games.html             ← game navigator/launcher
├── mythbound_admin_data.html        ← game data editor (skills/items/myths/dungeons/etc.)
└── mythbound_admin_minigames.html   ← minigames config editor
```

`mythbound_fishing.html` (solo-only) is **shelved** — do not use or reference it.

---

## PLAYER SAVE MODEL

```js
MB.PLAYER = {
  name:       'RAVEN',            // canonical id — always uppercase
  em:         '🐦',               // display emoji
  role:       'Striker',          // legacy display role (not the combat role)
  level:      12,                 // computed = SUM of all profession levels (no direct XP pool)
  coins:      4820,               // doubloons (displayed as "Doubloons" in all UI)

  myth:       'Phoenix',          // display name of bound myth (null if unbound)
  mythId:     'phoenix',          // canonical myth id (used for mechanics/skill lookup)

  equipped: {                     // hydrated item objects (NOT {id,qty})
    weapon:     { id:'...', name:'...', stats:{...}, traits:[...], ... },
    armor:      { ... },
    accessory:  { ... },
    myth:       { id:'myth_heart_phoenix', name:'Phoenix Heart', slot:'myth', ... }
  },

  bag: [ {id:'copper_ore', qty:31}, {id:'shadow_gem', qty:1} ],
  // !! bag is ALWAYS {id, qty} raw pairs. NEVER hydrated objects. !!
  // Read hydrated bag via MB.getBag() (read-only).

  professions: {
    fishing:        { level:5,  xp:220, xpMax:500 },
    mining:         { level:3,  xp:80,  xpMax:300 },
    herbalism:      { level:1,  xp:0,   xpMax:100 },
    hunting:        { level:1,  xp:0,   xpMax:100 },
    combat:         { level:2,  xp:60,  xpMax:200 },  // ← XP from physical/skill actions in battle
    magic:          { level:0,  xp:0,   xpMax:100 },  // ← XP from spell actions in battle
    blacksmithing:  { level:0,  xp:0,   xpMax:100 },  // craft — player picks ONE permanently
    // etc.
  },

  hp: 80, mp: 40, atk: 24, def: 14, spd: 14,  // legacy display fields, mostly unused now
  row:    'front',         // combat row position
};
```

**Key invariants:**
- `level` = `Object.values(professions).reduce((sum, p) => sum + p.level, 0)`. Recomputed via `MB.computeLevel()`.
- `bag` is the RAW source of truth. `MB.getBag()` returns a read-only hydrated view (merges item DB data).
- `equipped.myth` is the myth heart item bound on myth-binding — always the full item def.

---

## STAT MODEL (canonical — do not invent others)

```
stm  = Stamina     → HP pool (mhp = stm)
agi  = Agility     → ATB fill speed; also drives "finesse" (quick_slash)
def  = Defense     → physical damage mitigation (in damage formula as b.def)
wil  = Willpower   → magic defense (in damage formula as b.wil; wil IS the magic-def stat)
atk  = Attack      → physical damage scaling (a.atk in formula)
arc  = Arcane      → magic attack AND mana pool (mmp = arc * 8; a.arc in spells)
```

Derived:
```
mhp     = stm
mmp     = arc * 8
spd     = agi          (ATB speed)
mat     = arc          (RPG Maker alias)
mdf     = wil          (RPG Maker alias)
```

**Real battle stats** are computed in `computePlayerBattleStats()` in `battle.html`:
`base (_statModel.base) + equipped gear .stats + bound myth .statMods`. Not from `MB.PLAYER.atk` etc.

`_statModel.base` in `mythbound_data.json`:
```json
{ "stm":80, "agi":14, "def":6, "wil":8, "atk":12, "arc":5 }
```

---

## DAMAGE FORMULA SYSTEM

Formulas are **RPG Maker-style JavaScript expression strings** evaluated at runtime:

```js
"a.atk * 2.2 - b.def * 1.5 + 6"   // physical (b = def)
"a.arc * 3 - b.wil * 1.5 + 8"     // magic (b = wil)
"a.arc * 1.8 + 18"                  // heal (no b term)
```

- `a` = caster with attack buffs already folded in (atk_up/berserk/momentum/aegis multiply `a.atk`)
- `b` = target raw stats (Protect/Shell/def_up/def_down applied as separate % layers AFTER)
- Engine evals via `new Function('a','b','v','Math', 'return ('+expr+');')`
- Formula compile error → deals 0, logs warning — never crashes combat
- Post-formula pipeline: `× elementResist × protect/shell/blind × def_up/def_down/Brace × ±10% variance, min 1`
- **Physical** = element:'physical', b.stat used = `def`
- **Magic** = skill.type==='spell', b.stat used = `wil`, also gated by Shell (magic -50%) not Protect
- The skill's `element` field determines elemental resist mult. Resist is % reduction (negative = vulnerable)
- Available aliases in formulas: `mat=arc, mdf=wil, spd=agi, maxhp=mhp, maxmp=mmp, luk=agi`

**Basic attack** (no skill selected): `'a.atk * 2 - b.def * 1.5'` (constant `BASIC_PHYS` in battle.html)

---

## GAME DATA (`mythbound_data.json`) — Top-Level Keys

```
elements       → {physical, fire, frost, nature, void, arcana, light} — em, name, color, desc
combatRoles    → {tank, support, dps} — baseSkills[], favoredStats[]
skills         → {id: {name, em, type, effect, element, formula, target, mpCost, status, statusChance,
                       drain, resource, cure, mythReq, role, aegis, aegisKind, desc}}
statuses       → {id: {name, em, kind, effect, magnitude, duration, desc}}
animations     → animation definitions
combatEnemies  → {id: {name, em, hp, atk, def, wil, arc, agi, skills[], resist{}, drops[], xp, gold, boss, lines[]}}
dungeons       → [{id, name, kind, element, minLevel, desc, waves:[{name, boss, enemies:[id]}], clearReward}]
myths          → [{id, name, em, color, desc, element, statMods, resist, passive, startStatus, aegis}]
items          → {id: {name, emoji, rarity, type, slot, stats, traits, sell, desc, battle, soulbound, ...}}
_statModel     → {base, dmgRule, magicDefStat:'wil'}
```

### Skill fields (full):
```js
{
  name, em,                     // display
  type: 'skill'|'spell',        // 'spell' = magic XP, gated by Silence; 'skill' = combat XP
  effect: 'damage'|'heal'|'buff'|'debuff',
  element: 'fire'|'frost'|'nature'|'void'|'arcana'|'light'|'physical',
  formula: "a.atk * 2.2 - b.def * 1.5 + 6",   // JS expression string
  target: 'one-enemy'|'all-enemies'|'one-ally'|'all-allies'|'self',
  mpCost: 10,
  status: 'burn',               // status id to apply on hit
  statusChance: 0.5,            // 0–1
  drain: false,                 // true → siphon 50% of damage back (hp or mp based on resource)
  resource: 'hp'|'mp',         // for heal/drain
  cure: false,                  // true (on heals) → also purges target's debuffs
  mythReq: 'phoenix',           // myth id required to access this skill (null = universal)
  role: 'dps'|'support'|'tank', // combat role this skill is granted in (null = universal)
  aegis: true,                  // true = this is a myth's Aegis ultimate (3rd ability)
  aegisKind: 'timestop'|'rebirth'|'nova',
  extraStatus: 'slow',          // second status applied to all enemies by triggerAegis
  desc: '...'
}
```

### The 4 Myths (canonical as of this handoff):

| id | name | element | Aegis | aegisKind | startStatus |
|---|---|---|---|---|---|
| chrono_drake | (Raven renamed to "Chronos") | arcana | chronostasis | timestop | haste |
| phoenix | Phoenix | fire | immortal_flame | rebirth | — |
| void_wyrm | Void Wyrm | void | singularity | nova | — |
| glacial_leviathan | Glacial Leviathan | frost | absolute_zero | nova | — |

**Myth skill system:**
- Each myth grants **2 signature skills per role** (tagged `mythReq` + `role` on the skill object)
- The **Aegis** (3rd ability) is separate — tagged `aegis:true` on the skill
- `getPlayerSkills()` in battle.html scans all skills for matching `mythReq + role + !aegis`
- Player has myth stored as: `MB.PLAYER.myth = displayName`, `MB.PLAYER.mythId = canonicalId`
- `playerMythId()` in battle.html resolves by id or name (case-insensitive) — handles renames gracefully
- Skills that are `mythReq:'old_removed_id'` → effectively inaccessible (playerMythId returns null)

**Aegis flow:**
1. LB gauge fills to 100 during battle (physical hits add +8 to attacker LB; taking hits adds +10)
2. Player presses AEGIS button → **transform** (no turn consumed, armor FX plays on the player sprite)
3. `aegisActive = true` → the 3rd ability now appears in the ABILITY menu
4. Player casts the 3rd ability from ABILITY menu → `triggerAegis()` runs special effect:
   - `timestop` → `playTimeStopFX()` (fullscreen color-invert sweep), `G.timeStop={turnsLeft:2}`, player gets 2 free turns (enemies' ATB frozen, enemies don't act)
   - `rebirth` → player healed to full HP, debuffs purged, then fire nova damage to all enemies
   - `nova` → AoE damage to all enemies + status applied; `extraStatus` also applied (e.g., Absolute Zero adds Slow)
5. After casting: `aegisActive=false` (transformation ends); one use per battle

---

## COMBAT ENGINE (`mythbound_battle.html`)

### Architecture
- Boot: `MB.gameDataReady.then(showDungeonSelect)`
- **Solo party** — `assembleParty()` builds `[playerCombatant]`; server multiplayer party stub exists
- **DB-driven dungeons** — dungeon-select reads `MB.DATA.dungeons` live; starts with `startDungeon(id)`
- **Role** chosen on entry (tank/support/dps), default dps — set via `G.role`
- `G.timeStop = null | {turnsLeft:N}` — Chrono Drake time-stop state

### ATB Loop (tick, requestAnimationFrame)
```
each frame:
  if G.timeStop: only player ATB fills; enemy ATB frozen; no enemy turns
  else: all combatants fill ATB at effSpd(c) * 1.7 * dt
  player ATB ≥ 100 → your turn (if not stunned; stun = root|stop|sleep → skip + tick statuses)
  enemy ATB ≥ 100 → enemyAct(e) (1350ms throttle)
```

### Status effects (all DB-driven via `mythbound_data.json` statuses):
| effect value | behavior |
|---|---|
| dot | deals magnitude dmg per turn-tick |
| regen | heals magnitude per turn-tick |
| haste | effSpd ×1.5 |
| slow | effSpd ×0.6 |
| chill | effSpd ×0.7 (frost-flavored slow) |
| Surge | effSpd ×1.6 (legacy) |
| protect | physical damage taken ×0.5 |
| shell | magic damage taken ×0.5 |
| blind | physical damage dealt ×0.5 (accuracy) |
| berserk | atk ×1.5; enemy forced basic attack; player just gets atk buff |
| silence | cannot cast spells (type:'spell' disabled in menu; enemies skip spell selection) |
| sleep | skip turns until struck (waking removes sleep; hit dealDamage removes it) |
| stop | skip turns for duration |
| root | skip next turn (duration 1) |
| taunted | enemy AI targets this combatant |
| def_up | damage taken ×0.75 |
| def_down | damage taken ×1.25 |

Status tick: happens at the **end of each actor's turn** (in `tickCombatantStatuses(c)`, called from `endTurn()` and after enemy acts). Durations stored in `c.statusDur[id]`.

### Damage pipeline
```
raw     = formulaDamage(src, tgt, sk.formula)      // evaluates formula string
       += blind  → raw × 0.5 (if attacker blinded, physical only)
       ×= elementResist
       ×= protect/shell (physical/magic)
       ×= def_up (×0.75) or def_down (×1.25) or Brace (×0.5, consumed)
       ×= ±10% variance
dmg     = max(1, round(raw))
```

### XP / Rewards
- **combat XP**: earned on physical attack, skill-type abilities, and on enemy kills from physical
- **magic XP**: earned on spell-type ability casts, and on enemy kills from magic
- Small XP per damaging hit: `max(2, round(dmg × 0.25))` — accumulated in `G.run`
- Enemy death: `G.run.doubloons += def.gold`, `G.run[type+'Xp'] += def.xp`, drops recorded in `G.run.drops`
- **All rewards granted ONLY on victory** via `grantRunRewards()`:
  - `MB.addToInventory(id, qty)` for each drop
  - `MB.addXP('combat', n)` and `MB.addXP('magic', n)`
  - `MB.addCoins(doubloons)` + `MB.savePlayer()`
- On DEFEAT: no XP/doubloons granted (drops already recorded but not persisted — see G.run)

### Enemy AI
- Checks stun (root/stop/sleep) → skip
- Checks silence → no spells; berserk → forced basic attack
- 60% chance to cast a DB skill (random from enemy.skills[] filtered by MP)
- Falls back to basic attack
- Taunted player overrides target selection

### Rendering
- `drawField()` — rebuilds `#p-side` and `#e-side` innerHTML each frame (OK for sprites/status chips)
- `renderPartyStack()` — builds `.pm` DOM **once** per party composition (keyed by player ids), then only **updates widths/text/classes per frame** — this is critical so CSS animations (LB rainbow wave, glow) and width transitions (smooth fill) actually work. Do NOT rebuild `party-stack.innerHTML` every frame.
- Status chips via `chipFor(id)` → shows full status name with emoji (e.g. "🔥 Burn", "⏩ Haste"), no abbreviations
- LB bar: two CSS animations: `lbsat` (0.7s fast wave on `.bf.lb-full`) + `lbglow` (1.4s RGB cycling border on `.bbg.lb-glow`); uncharged: `lbdim` (6s slow drift) + `filter:saturate(.65)`

---

## SOCIAL SYSTEMS (`mythbound_hub.html` + server)

- **SSE streams** for whispers and social notifications (replaced long-polling)
- **Whisper queues** persisted to `_mythbound_queues.json` (server-reload resilient)
- **Friend system**: bilateral friend requests, accept notifications, bilateral unfriend
- **Blocking**: blocks list per player; blocked players can't whisper or social-notify
- **Presence**: `MB.startPresenceReporter('PageName')` in `mythbound_shared.js` — called on every page, posts presence heartbeat, uses `navigator.sendBeacon` for reliable tab-close detection
- **Trade system**: server-authoritative trade with `MB._tradeLock`, atomic, `/__trade/*` endpoints

---

## AUCTION HOUSE (`mythbound_auction.html` + `mythbound_ah.json`)

- SSE live updates broadcast to all viewers on listing/purchase/cancel
- 5% listing fee (inflation sink)
- System mail sent to seller on purchase and buyer on cancel
- Listings persisted to `mythbound_ah.json`

---

## ADMIN SYSTEMS

### `mythbound_admin_data.html` — Game Data Editor
Two sidebar groups:
- **GAME DATA**: Items, Rocks (mining), Mine Enemies, Economy, Myths, Chat Roles
- **BATTLE DATABASE**: Combat Roles, Skills, Statuses, Weapons, Armors, Combat Enemies, Dungeons, Animations

Key UX:
- Skills editor has **Requires Myth** dropdown (myth id or none) + **Granted In Role** dropdown — so skill tagging is editable in the UI
- Skills editor has **RPG-Maker formula helper** with a TEST FORMULA button (compiles with sample stats, shows damage or error)
- Dungeon editor is a **friendly wave builder** — enemies picked from a dropdown of `combatEnemies` (not free-text), preventing "?" phantom enemies
- Save flow: `DATA` → `saveEdit()` routes by section → `saveAll()` → `MB.saveGameData(DATA)`

### `mythbound_hub.html` Admin Panel (in-hub, for mods)
Tabs: SEND ITEMS | UNMYTH | GRANT MYTH | (monitor, players, flags, action log)
- **GRANT MYTH**: input player name + pick myth from live dropdown → validates account exists → writes myth + equips heart to player save + live session. For testing mythbound battle.
- **UNMYTH**: removes mythbinding + clears myth slot.
- Both write to `localStorage mythbound_player_v2_<NAME>` + `mythbound_accounts_v1`. Live session updated if the player is currently signed in.

### `mythbound_admin_minigames.html`
Fields map directly to the `FC` object used by the game engine. `BroadcastChannel` live-propagates changes to all open tabs.

---

## MYTH HEART BINDING (`mythbound_inventory.html`)

- Generic `myth_heart` item → USE → `doMythBind()` → rolls from `MB.DATA.myths` (the 4 current myths)
- Old hardcoded 10-myth `MYTHS` array is a fallback only (in case `MB.DATA.myths` is empty)
- Stores: `MB.PLAYER.myth = myth.name` (display), `MB.PLAYER.mythId = myth.id` (canonical)
- Equips `myth_heart_<mythId>` item into `MB.PLAYER.equipped.myth` (built from DB myth data)
- **Self-heal migration**: `validateMyth()` runs on page load (in `MB.onReady`) — if the player's bound myth isn't in `MB.DATA.myths`, it's cleared and saved. Old myths auto-removed on next inventory visit.

---

## ECONOMY RULES

- Currency: **Doubloons** (JS field: `MB.PLAYER.coins`)
- Gathering professions: fishing, mining, herbalism, hunting (each level 1–100)
- Combat professions: combat, magic — level up via battle actions
- Craft professions: blacksmithing, cooking, alchemy, leatherworking — **one per player, permanent** (500 doubloon reroll cost), full progress lost on switch
- Professions are interdependent — no self-sufficiency by design
- Drop rates: common >50%, uncommon ~25%, rare ~10–15%, legendary always <1% (never farmable)
- Legendary drops never become farmable regardless of level
- AH is player-to-player (no coins created/destroyed by the AH itself)
- NPC buy at 40% of sell value (incentivizes player trading)
- AH listing fee: 5% (inflation sink)

---

## SUPABASE MIGRATION PLAN

The migration is a **persistence-layer swap only**. All game logic, formulas, and rendering stay exactly as-is.

**Read this first — the persistence architecture (confirmed in `shared.js`):**
- The **server (`server.js`) is the source of truth** for accounts, player saves, and mail. It persists to the flat JSON files (`_mythbound_accounts.json`, etc.).
- **localStorage is a per-browser CACHE only.** It's refreshed authoritatively at login and written on every save as an offline fallback. It is NOT the source of truth — do not aim the migration at localStorage keys.
- The bridge between client and server is `MB.SERVER` (base URL) + a set of `/__*` fetch endpoints. `shared.js` already contains the migration note: *"To migrate to Supabase: point MB.SERVER at your project / swap these fetches for supabase table calls. The call sites don't change."*

So the real change happens in (a) the **server-sync functions in `shared.js`** and (b) the **`/__*` endpoints in `server.js`** — NOT in `MB.savePlayer()`/`MB.loadPlayer()` (those manage the localStorage cache and should keep doing so).

### What maps where

| Current | Supabase |
|---|---|
| `_mythbound_accounts.json` (server-authoritative: username/hash/session/save) | Supabase Auth + `players`/`profiles` tables |
| `localStorage mythbound_player_v2_<NAME>` (cache only) | stays as offline cache — unchanged |
| `localStorage mythbound_accounts_v1` (cache only) | stays as offline cache — unchanged |
| `_mythbound_queues.json` (whispers/presence/AH mail) | `whisper_queue`, `presence`, `ah_mail` tables |
| `mythbound_ah.json` | `ah_listings` table |
| SSE streams | Supabase Realtime (channels per feature) |
| `mythbound_data.json` | Keep as flat file OR `game_config` table (flat file is fine — read-only game data) |
| `server.js` `/__*` endpoints | Supabase Edge Functions OR repoint `MB.SERVER` at a thin gateway |

### `players` table schema
```sql
CREATE TABLE players (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  name TEXT UNIQUE NOT NULL,            -- always uppercase, the canonical identifier
  em TEXT DEFAULT '🐦',
  role TEXT DEFAULT 'Adventurer',
  level INTEGER DEFAULT 0,             -- computed on save from professions
  coins INTEGER DEFAULT 0,             -- doubloons
  myth TEXT,                           -- display name
  myth_id TEXT,                        -- canonical id (used for mechanics)
  bag JSONB DEFAULT '[]',              -- [{id, qty}] ONLY — never hydrated
  equipped JSONB DEFAULT '{}',         -- {weapon, armor, accessory, myth}
  professions JSONB DEFAULT '{}',      -- {fishing:{level,xp,xpMax}, ...}
  friends TEXT[] DEFAULT '{}',
  blocked TEXT[] DEFAULT '{}',
  row TEXT DEFAULT 'front',
  hp INTEGER DEFAULT 80,               -- legacy display
  mp INTEGER DEFAULT 40,               -- legacy display
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

### Shared.js migration points
**Do NOT rewrite `MB.savePlayer()`/`MB.loadPlayer()`** — they manage the localStorage cache and should keep doing so (offline fallback). Instead swap the **server-sync layer** these are the exact functions:

**`MB.serverSavePlayer()`** — currently debounced `fetch(MB.SERVER + '/__player/save', {name, token, player})`:
```js
// NEW (preserve the debounce + the MB._tradeLock guard + session token):
MB.serverSavePlayer = function() {
  if (MB._tradeLock) return;                         // mid-trade: server owns the save
  const s = MB.getSession(); if (!s || !s.name) return;
  clearTimeout(MB._saveTimer);
  MB._saveTimer = setTimeout(async () => {
    if (MB._tradeLock) return;
    await supabase.from('players').upsert({
      name: s.name,                                  // uppercase canonical id
      bag: MB.PLAYER.bag,                            // [{id,qty}] only
      coins: MB.PLAYER.coins,
      professions: MB.PLAYER.professions,
      equipped: MB.PLAYER.equipped,
      myth: MB.PLAYER.myth, myth_id: MB.PLAYER.mythId,
      level: MB.PLAYER.level,
      // ...remaining fields
    }, { onConflict: 'name' });
  }, 1500);
};
```

**`MB.reloadPlayerFromServer()`** — currently `fetch(MB.SERVER + '/__player/load?name=')`, merges authoritative gameplay fields:
```js
// NEW: same merge list — only gameplay fields, identity stays as-is:
MB.reloadPlayerFromServer = async function() {
  const s = MB.getSession(); if (!s || !s.name) return false;
  const { data } = await supabase.from('players').select('*').eq('name', s.name).single();
  if (!data) return false;
  ['bag','coins','professions','equipped','craft','craftLevel','craftXp','stamina','myth','mythId']
    .forEach(k => { const col = k==='mythId'?'myth_id':k; if (col in data) MB.PLAYER[k] = data[col]; });
  return true;
};
```

**Easiest path of all:** keep the server-sync functions as-is and just **repoint `MB.SERVER`** at a Supabase Edge Function gateway that implements the same `/__*` routes. Then zero client code changes — the existing `shared.js` comment confirms this was the intended design.

**Must preserve in any swap:** the `MB._tradeLock` guard (so a trade's authoritative result isn't clobbered by a stale push), the debounce, the session-token validity check (server returning `valid:false` → `MB._handleKicked()` for single-session enforcement), and `MB.hydratePlayer()` must STILL never touch `MB.PLAYER.bag` (bag-corruption history).

### Server endpoints to migrate (`server.js` `/__*` routes)
Account: `/__account/create`, `/__account/login`, `/__account/logout` · Player: `/__player/save`, `/__player/load` · Mail: `/__mail/list`, `/__mail/send`, `/__mail/save` · Social: `/__social/*` (friends/blocks) · Whispers: `/__whisper/*` · Trade: `/__trade/*` (atomic, server-locked) · Auction: AH listing/buy/cancel · Presence: heartbeat + `sendBeacon` logout.

### Auth swap
```js
// CURRENT (server session cookie):
MB.requireAuth = function() { /* checks session cookie */ };

// NEW (Supabase):
MB.requireAuth = async function() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { MB.nav('auth'); return false; }
  MB.PLAYER.name = session.user.user_metadata.name?.toUpperCase();
  return true;
};
```

### Realtime (replaces SSE)
```js
// Whispers:
supabase.channel('whispers:'+MB.PLAYER.name)
  .on('postgres_changes', { event:'INSERT', schema:'public', table:'whisper_queue',
      filter:'recipient=eq.'+MB.PLAYER.name }, payload => handleWhisper(payload.new))
  .subscribe();

// Presence:
const presenceChannel = supabase.channel('presence');
presenceChannel.track({ name: MB.PLAYER.name, page: currentPage, myth: MB.PLAYER.myth });
```

### Game data
`mythbound_data.json` can stay as a flat file served by Netlify — it's read-only game configuration. If you want it editable without redeploying, add a `game_config` table with a JSONB `data` column and a single row. The admin data editor's `MB.saveGameData()` becomes a Supabase upsert.

### Migration order (recommended)
1. Auth (sign-in/create account: `/__account/*`) → Supabase Auth
2. Player saves: swap `MB.serverSavePlayer` + `MB.reloadPlayerFromServer` (or repoint `MB.SERVER`) → `players` table. Keep localStorage cache.
3. Social (friends/blocks/whispers: `/__social/*`, `/__whisper/*`) → tables + Realtime
4. Presence → Realtime
5. Auction house → `ah_listings` table
6. Mail (`/__mail/*`) → `mail` table
7. Trade (`/__trade/*`) → keep atomic/locked (Postgres transaction or Edge Function)
8. Game data (optional, last) → `game_config` table OR keep flat file

---

## KNOWN STATE / REMAINING BACKLOG (as of this handoff)

### Completed systems ✓
- Server-authoritative accounts, sessions, saves, mail
- Social: friend requests, bilateral unfriend, blocking
- Whispers with SSE + persisted queues
- Trade engine (atomic, server-locked)
- Auction house (SSE live, 5% fee, system mail)
- Fishing minigame (lobby, canvas, delta-time, Stardew physics)
- Mining minigame
- Minigames admin panel
- Chat hub redesign (text layout, online sidebar, profile card)
- Inventory page (equip/unequip, myth binding, self-heal for old myths)
- **Full ATB combat engine** (DB-driven dungeons, enemies, skills, statuses, drops, XP, doubloons)
- **4 myths** with per-role signature skills, tagged on skills, Aegis ultimates
- **RPG Maker formula strings** evaluated at runtime
- **FF-style statuses** (Haste, Protect, Shell, Slow, Berserk, Blind, Silence, Sleep + existing)
- **XP split**: combat XP (physical/skills) vs magic XP (spells); level = sum of profession levels
- Victory/Game Over screens with reward display
- Admin: grant myth, unmyth, friendly dungeon wave builder, formula tester
- Battle debug panel (Fill Aegis, Full HP/MP, Clear Wave, Recharge Aegis)

### Backlog / outstanding
- Multiplayer party in battle (stub in `assembleParty`; `MB.getDungeonParty` is a stub)
- Character/profile page (no dedicated page yet)
- Herbalism + hunting minigames (WIP placeholders)
- Crafting professions in-game (data model exists; no UI)
- Clan/guild system (no persistence yet)
- Persistent global chat history (in-memory only)
- Player housing / walking-avatar rooms (concept reserved, not built)
- Leaderboards
- Trade history / economy logging
- Admin: friendly per-field forms for skills/statuses/combat enemies (currently JSON box; dungeon editor and skill mythReq/role are friendly)
- 2FA gate on admin DB-mutating endpoints before going public
- Supabase migration (this document)

---

## PAGES THAT ARE NOT UPLOADED BUT EXIST

The following pages exist in Raven's project folder but may not be uploaded in a given conversation. **Ask for them before editing.** Do not rebuild from scratch.

- `server.js` — any endpoint or session changes need this
- `mythbound_shared.js` — any change to MB.* helpers needs this
- `mythbound_mail.html`
- `mythbound_auth.html`
- `mythbound_games.html`
- `mythbound_fishing_lobby.html`
- `mythbound_mining.html`

---
*End of handoff. This document supersedes the original SUPABASE_HANDOFF.md.*
