# MYTHBOUND — Data-Driven Battle System: Architecture

This is the plan for turning the battle mockup into a real, modular, RPG-Maker-style
system where you add/remove dungeons and tune enemies from the admin panel in minutes.

## The core idea: one database, three consumers

```
        mythbound_data.json   (+ the new combat_db tabs merged in)
        served live at /__data
                 │
   ┌─────────────┼──────────────┐
   ▼             ▼              ▼
 ADMIN         BATTLE        INVENTORY /
 EDITOR        ENGINE        GAMEPLAY LOOP
 (edit tabs,   (reads defs,  (item/weapon/armor
  push live)    runs fight)   stats, myth bind)
```

Nothing in the battle engine is hard-coded. A dungeon, an enemy, a skill, a status, an
animation — all are rows in the database. Edit a row in the admin panel, push, and the
next battle uses it. This is exactly the "edit enemies in RPG Maker, changes go live" loop.

## The 7 database tabs (in `mythbound_combat_db.json`)

| Tab | Keyed by | What it defines | Referenced by |
|-----|----------|-----------------|---------------|
| **elements** | id | The element wheel (strong/weak). Two triangles + neutral physical. | everything with an `element` |
| **myths** | id (array) | Class-like definitions: stat bonuses, element, resist/weak, skill list, passive, limit-break. Merges into your existing `myths[]`. | player when myth-bound |
| **skills** | id | Moves: kind, element, power, mp/atb cost, target, scaling stat, animation, applied status. | myths, enemies, the battle menu |
| **statuses** | id | Buffs/debuffs: effect (dot/regen/stat/stun/shield), magnitude, duration. | skills, enemies, battle loop |
| **animations** | id | Browser-friendly effects (flash/shake/projectile/nova/heal): color, emoji, shake, duration. No asset files needed. | skills, statuses, items |
| **enemies** | id | Combat foes: stats, element, resist/weak, AI, skills, drops, boss phases, Undertale flavor `lines`. | dungeons, battle engine |
| **dungeons** | id (array) | Ordered floors → weighted encounters (enemy groups) → rewards. `kind:'raid'` = multi-player + boss phases. | the dungeon select / battle entry |

### How a reference resolves (example)
Player enters `whispering_hollow` → engine picks a floor → rolls a weighted `encounter`
→ spawns `['sprite','fungus']` from **enemies** → each enemy's `skills` resolve from
**skills** → a skill's `element` checks **elements** vs the target's `weak`/`resist` →
on hit it applies its `status` from **statuses** and plays its `anim` from **animations**.
Win → `drops` + floor/clear `reward` flow into the inventory (server-backed).

## Stat model (extends what you already have)

Player already has: `hp/mhp, mp/mmp, atk, def, spd, lb, level`. The engine computes
**effective stats** at battle start:

```
effective = base(player)  +  myth.statMods  +  Σ equipped item.stats  +  active status mods
mag (magic power) = new derived stat: base from level + myth.statMods.mp-ish + gear `mag`
```

- **ATB**: each combatant's bar fills by `spd` × dt. At 100% they may act. (FF7 active.)
- **Limit/Burst gauge** (`lb` 0–100): fills as you take/deal damage. At 100 the myth's
  `limit` skill unlocks (free, ignores MP/ATB). Aegis (your existing ✦ AEGIS) is the
  defensive spend of that gauge — I'll wire it to a `def_up`/`shield` status.
- **Elements**: damage × 1.5 if attacker's element is `strong` vs target (or target `weak`),
  × 0.5 if target `resist`. Myth binding sets your element + affinities.

## Battle engine = interchangeable modules

I'll refactor `battle.html`'s one big `G` object into named modules so we can work on
each in isolation (your "interchangeable parts"):

1. **loader** — fetch `/__data`, resolve an encounter into live combatant objects.
2. **stats** — compute effective stats (base + myth + gear + status).
3. **atb** — the tick loop + turn ordering.
4. **actions** — attack / skill / item / aegis / limit; targeting; element math.
5. **status** — apply/tick/expire buffs & debuffs.
6. **anim** — map an animation id → a CSS/JS routine (keeps the Undertale look).
7. **ai** — enemy decision by `ai` pattern (aggressive/caster/defensive/boss-phases).
8. **ui** — render field, HUD, party stack, the Undertale textboxes (kept from the mockup).
9. **rewards** — roll drops, grant xp/coins/items to the server-backed inventory.

The Undertale aesthetic (in-field enemy textboxes, ATB bars, party stack) is already
in your mockup — that becomes the **ui** module; we keep the look, swap the guts.

## Admin editor: new tabs

`admin_data.html` already has the section-tab + table-editor + push-live pattern
(ITEMS / ROCKS / ENEMIES / ECONOMY / MYTHS / ROLES). I'll add tabs:
**MYTHS (combat fields)**, **SKILLS**, **STATUSES**, **ANIMATIONS**, **COMBAT ENEMIES**,
**WEAPONS/ARMORS** (filtered views of items by slot), **DUNGEONS**. Each is a table whose
columns map 1:1 to the schema fields — the same way the FC object maps panel fields today.

> Security note: agreed — before this editor is exposed beyond you, it needs hard auth
> (2FA / hardware key). For now it stays behind the existing admin gate; I'll flag the
> exact endpoints that mutate the DB so they're easy to lock down later.

## Decisions I made (tell me to change any)

1. **One item store, filtered tabs** for weapons/armors (vs three separate stores). Keeps
   the bag/inventory lookup simple — an item id resolves in one place. The admin still
   gets RPG-Maker-style separate WEAPONS / ARMORS tabs (filtered by `slot`).
2. **`mag` (magic power)** is a new derived stat so magic scales separately from `atk`.
3. **Element wheel** = two triangles (fire→nature→frost→fire, void→light→arcana→void) +
   neutral physical. Simple, readable, easy to balance.
4. **Dungeons are data**; raids are dungeons with `kind:'raid'` + `partySize` + boss `phases`.

## Forks I'd like your call on (not blocking — I'll assume the **bold** default)

- Party: **fixed allies for now** (your mockup's RIBBIT/FOXPAW/etc.) vs. real recruited party.
- Limit gauge fills from: **damage dealt + taken** vs. time vs. kills.
- Magic stat source: **derived from level + myth + gear** vs. a full new player stat you assign.

## Proposed build sequence

1. ✅ **This step:** schema + populated DB + architecture (done — you're reading it).
2. **Battle engine refactor:** loader + stats + atb + actions, running one real encounter
   from `whispering_hollow` end-to-end (attack/skill/item/element/win→drops), keeping the
   Undertale UI. This is the big one and where we'll iterate on feel.
3. **Status + AI + animations** modules fleshed out (DoTs, buffs, boss phases, the effects).
4. **Admin editor tabs** for the combat DB so you edit enemies/skills/dungeons live.
5. **Dungeon select + raid (multi-player) + inventory/myth-bind tie-in** polish.

Tell me to proceed to step 2 and I'll build the engine against this schema.
