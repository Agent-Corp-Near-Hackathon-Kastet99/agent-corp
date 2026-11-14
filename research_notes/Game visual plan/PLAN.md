# RAM HEIST — "make it awesome" research + plan (2026-11-14)

Status: PROPOSAL ONLY. Nothing here is implemented. Reference screenshots of Robbery Bob: `/tmp/rb/*.png` (not committed; third-party art).

## 0. Where we are today (from code + live page)

- `server/web/game.js` draws everything procedurally on a 960x620 canvas: flat beige tiles, 56px grid, rounded-rect people. 13x9 tile map, one level (`HOUSE_01`).
- Movement is **tile-by-tile, 4-direction**, and **every tick is an HTTP call** (`api('/api/game/step')`). Server is authoritative, level data is gated by on-chain pass. Great for integrity, bad for feel: input lag, no interpolation beyond a 180ms blend, no room for juice.
- UI is a website page (header, brief card, arrow buttons below the board) rather than a game screen.
- Rules engine `heist-core.js` is pure and shared by browser + tests. This is the asset to keep: we can run it client-side for prediction and keep the server as the referee.

## 1. Trends (what is real, what is thin)

Sources are mixed; several are vendor blogs or AI-written. Treat numbers as directional.

**AI gamedev / browser**
- Browser is now the default first home of a game: Google Labs "Playground" (prompt-to-game, Oct 2026), Roblox "Build", Vibe Jam 2026 (~945 entries, 90% AI-written code rule). Consequence: **volume of AI games is exploding, so generic output reads as slop**. Differentiation = art direction, juice, identity, a real hook.
- Sentiment: GDC 2026 says 36% of devs use genAI, but only ~7% think it is positive; artists are most negative. Do not ship "obviously AI" art. AI should be a *pipeline*, a human art-director picks one coherent style.
- 3D-in-browser is viable: Leonardo "Highlands Runner" (AI-assets via Rodin V2) built in under a week. Asset tools named: Meshy 6, Tripo, Rodin V2.
- Runtime AI characters on small models (Hugging Face "Build Small": Peek & Seek, SWEATBOX where NPC thoughts differ from words). Idea fit: our guards.
- Nexon reportedly uses Claude Code end-to-end for live service: agent-driven iteration is mainstream, fine for us.

**Twitch (Twitch State of Gaming 2026, Sep)**
- Indie-tag hours +51% (348M+). Horror 287M hours, creature/cozy 142M, sandbox 831M. Named: Meccha Chameleon, Slay the Spire 2, Big Walk, Phasmophobia, Dead by Daylight, Slime Rancher, Pokopia. Drops-enabled streams 1.6B hours.
- The post does **not** explain why. My inference (not sourced): streamable = a readable tension loop with clippable spikes (jump-scare / near-miss / fail), cozy-creepy tone, chat can predict outcomes. A stealth game with a 3-second "oh no" moment fits that.

**SF Twitter, this month (thin: no direct X access, only press roundups)**
- RAM shortage is a live joke: Altman "Hands off my RAM, Sam I Am", used PS5 Pro reportedly ~$1,400. **Our game is literally called RAM HEIST** — this is the strongest free hook we have.
- Halloween costume memes: "rogue agent escaping its sandbox", "human in the loop", "Ava, the AI BDR", vaguepost king, "time to nuke SF", Sankey diagram. AI-bubble anxiety after a big selloff.
- Biggest raw meme event: Jensen Huang scandal (Nov 8-9). **Recommend we do not touch it** (real people, affair, reputational risk, dates fast).
- Events: YC Demo Day Nov 18, Microsoft Ignite SF Nov 17-20 — good clip-drop windows.

## 2. Robbery Bob — how it works (observed on phone + noted from memory)

**Observed (tutorial section, movement, HUD, store; I did not reach a full level end):**
- Landscape, top-down 3/4 view, **roof cut away** so you see rooms from above. Camera smooth-follows Bob; world is much bigger than the screen.
- **Analog virtual joystick** bottom-left (appears under thumb), one **sneak/run shoe button** bottom-right. Tiny HUD: pause, fast-forward, backpack (gadgets), loot-bag meter top-right, coin counter that pops on gain.
- **Loot readability**: stealable items sparkle/glint; a chest icon with a blue arrow clamps to the screen edge and points to the next objective, flipping direction when you are near.
- **Threat readability**: a patrolling NPC leaves a **dotted route ahead of them; dots turn red where they will pass**. Off-screen NPCs show as a blue "!" triangle at the screen edge. No vision cones needed, the route itself is the telegraph.
- Texture: painterly hedges, doormat that says "Welcome", props with soft drop shadows, warm interior light, dark bathroom tiles. Rooms have strongly different colour identities (orange hall, red carpet/kitchen, navy bathroom).
- **Story framing**: comic portraits with speech bubbles in a hand-lettered font; a partner guides you (orange hat), a hooded shopkeeper sells upgrades. Tone is jokey ("Expensive stuff. Got it!").
- **Meta loop**: coins -> store with Abilities (Stealth, Stamina, Grab-ability, Speed; segmented bars, ~20 coins per step), plus more categories below. Progression is visible, cheap and frequent.
- Friction I hit: Bob snagged on door/plant edges with a stick. Their collision is forgiving but not perfect. Ours should be better.

**From memory, not verified this session:** levels end at an exit with a star rating; hiding in furniture; getting caught resets the level; gadgets/outfits; many themed locations.

**What to take, what not:** take camera, analog control, telegraph-by-route, edge indicators, sparkle-on-loot, comic dialogue, upgrade shop with fast cadence, strong per-room colour. Do **not** copy characters, art, names or the cut-away house look 1:1. Our identity is startup/AI satire.

## 2b. Robbery Bob core mechanics (deep dive, from screen recording + play)

Method: I played level 1 ("Easy Peasy", Suburbs) and screen-recorded the phone, then read contact sheets of the video. The recording also caught two complete runs I did not input (presumably yours). Wiki pages (fandom 402, TouchArcade 403) were blocked, so numbers like noise radius are NOT known. Things marked (?) are not verified.

**Core loop (about 50-90 seconds per level):** enter house -> steal loot -> avoid residents -> reach an exit. Scored on three objectives, retried instantly.

1. **Camera + scale**: one house is bigger than the screen. Camera follows Bob, roof cut away so you read rooms from above. Rooms carry strong colour identity, so you always know where you are.
2. **Movement**: slow, deliberate walk (about 5 s to cross a hall). Floating analog joystick on the left, a shoe button on the right (sneak/run toggle, effect not tested (?)). Slow speed is what makes timing the whole game.
3. **Objective guidance** (this is the big UX trick):
   - Before loot: blue chest arrow clamps to the screen edge pointing at the next loot.
   - After loot: green running-man **EXIT** markers appear at the screen edge for each exit. The goal changes and the UI tells you without text.
4. **Loot**: items sparkle. Walking onto them grabs them (no tap seen (?)), a jokey name label pops up ("Frying Pan", "Leftover Steak"), the loot bag top-right fills, coins tick. Not all loot is required: the ring shows a **Loot %** (16%, 25%), so greed is optional and scored.
5. **Residents / guards** (granny in purple on this level):
   - Patrols a fixed loop. The **dotted route** is drawn on the floor: dots near her are **red** (imminent), farther ones white/pink (later). You read timing from colours, no vision cone needed.
   - Off-screen threats show as a blue "!" triangle on the screen edge pointing to them.
   - Furniture blocks line of sight, so a desk or sofa in the middle of a room is cover and a route choice.
   - **Caught** = stars spin round Bob, smoke puff, freeze, then a modal.
6. **Hiding**: Bob stepped into a hedge and was drawn half-hidden at its edge. Whether it makes him safe from the granny was not tested (?). Wiki text (secondary): bushes/closets/furniture hide you, and guards do not check a spot unless they saw you enter.
7. **Fail flow** (very fast): "Smoke Bomb Escape: resume immediately, briefly invisible, remain unseen" -> **Buy 150 coins** or "Not now" -> **BUSTED!** radial menu: Upgrades / Retry with Shadow Bob (?) / Retry. Iris-wipe circle transitions. Retry resets to start in about 2 seconds, no loading screen.
8. **Results**: a round badge cycles through **three medal objectives**: Undetected, Time (e.g. 00:53 vs Target 00:45), Loot %. Failed medals get a red X. Then **score** (259, with High score), coins collected counter, and Menu / Retry / Next buttons. Difficulty label ("Easy Peasy") shown in the header.
9. **Meta**: overworld map per chapter (Suburbs, Downtown, Secret Labs, Prison, Advanced, Winter), chapter cards with % complete, a path of level nodes (yellow/orange by difficulty) with Bob standing on the current one. Coins buy abilities (Stealth, Stamina, Grab, Speed; about 20 coins per step) and one-shot gadgets like Smoke Bomb Escape (150). Ad/IAP hooks: "Go Ad Free", coin "+" button, paid revive.
10. **Tone and pacing devices**: partner character interrupts mid-level with speech-bubble dialogue and a first-level tutorial; comic font; jokey item names; coins and loot always visible.
11. **Reviewer criticism** (Wikipedia mirrors): TouchArcade says sneaking goes from "real strong" to "a repetitive room-by-room hunt" and is "luck-based"; Pocket Gamer calls controls "clumsy". Lesson: variety per level and fair, readable telegraphs matter; do not rely on trial-and-error.

### What this means for us
- Our one level should be 45-90 s, not an open sandbox, with a **target time**, **undetected** and **loot %** triple-medal ring at the end.
- Replace "spotted -> text" with: stun stars + smoke, then instant retry (under 2 s). A revive/"smoke bomb" is optional and, in our case, should be earned with coins, not paid.
- The **goal-arrow system** (loot arrow -> EXIT arrow, "!" off-screen threat arrow) is cheap and carries most of the UX.
- **Telegraph route as coloured dots** (red now, white later) is the key readability tool. In 3D we render it as a floor decal/line with the same colour logic.
- Slow, weighty walking plus a sneak/run choice with a noise trade-off. Pace is what makes it stealth rather than racing.
- Put cover in the middle of rooms (desk, sofa), so players choose routes instead of just following walls.
- Room colour identity and humorous item names carry personality. For us: SF/AI props ("Used H100", "Series A term sheet", "Cold-brew keg", "Founder's context window").

## 3. Proposed direction: "Pixar-lite SF startup heist"

One-line pitch: *You are a rogue agent escaping the sandbox. Steal the founder's RAM before the "human in the loop" catches you.*

### 3.1 Look (pick ONE and commit)
Recommended: **stylised 3/4-top-down in Three.js (WebGL) with low-poly props, baked-look lighting, soft shadows, a single warm/cool lighting palette per room.** Not a flat tile grid. Reasons: browser-friendly, cheap to ship, AI-assisted assets (Meshy/Tripo) can fill props, one art director keeps it coherent, and it clips well on Twitch.
Cheaper fallback if 3D is too much: **hand-painted 2D sprites in Phaser/PixiJS** (like Robbery Bob). Pick after a 1-day spike (see roadmap).

- Rooms with identity: neon-lit "AI lab" bedroom, kitchen with cold-brew taps, Aeron-chair office, server closet. SF-flavoured props: whiteboards of Sankey diagrams, standing desk, "Hands off my RAM" sticker, YC-style posters, Waymo plush.
- RAM stick = hero object: glowing, rotating, particle trail.
- Lighting: guard flashlight cone as a real light, rest of room dim. Screen-space vignette, bloom on pickups, soft contact shadows.
- Character design: expressive silhouette for the player agent (a small floating terminal/cursor-with-limbs?) and 3 resident archetypes ("Founder", "Roommate", "Robo-vacuum").
- Typography: chunky comic display font + monospace micro-labels, not the current website look.

### 3.2 Not "block by block": movement and camera
- **Free analog movement** (continuous, sub-tile) with circle collision and wall sliding; keep the grid only as the level-authoring and AI-pathing layer.
- Camera: smooth follow + look-ahead + slight zoom out when sprinting; room-reveal when you open a door (fade the next room's lights up).
- Keyboard: WASD/arrows + Shift. Touch: floating joystick + sneak button (mirrors RB, proven). Gamepad free via Gamepad API.
- **Client-side prediction + server referee**: run `heist-core` locally at 60Hz, send input batches ~10Hz, server replays and returns checkpoints; rollback only on mismatch. Removes the per-tick HTTP lag. Keep the on-chain-pass level gate.

### 3.3 Gameplay upgrade (still small)
- **Telegraph like RB**: dotted patrol route with red zones + off-screen "!" arrows; plus a flashlight cone. Pick route-dots *or* cones for readability, not both at full strength.
- Noise system: sprinting makes rings, bumping props (flowerpot already exists) distracts, throwable item.
- Hide spots (wardrobe, under desk, bean bag): hold-to-hide with a short peek mechanic.
- **Chase = the clip moment**: music stem swap, slow-mo punch-in at near-miss, big "SPOTTED" stamp, rear-view guard bark.
- Resident personalities with AI barks (small model or pre-written pool first): the Founder muttering "who keeps eating my context window", Roommate on a call, Roomba trap.
- Level 2+: a **procedural/AI-assisted level generator** from the existing level format, validated by the shared engine (solvable check by BFS already in `route`).
- Meta loop: coins from loot -> upgrade Stealth/Stamina/Speed/Grab (RB-style) and cosmetic skins. Run timer + rank for replay value.

### 3.4 UX: from "website with a canvas" to "a game"
- Full-viewport game screen, HUD on the canvas (RAM count, stamina ring, minimap pip), no page chrome while playing.
- Real title screen -> brief -> play -> result screen with stars, time, stolen RAM, "share clip" button.
- Comic cutscene panels for mission intro (RB-style speech bubbles), skippable.
- Mobile-first layout (landscape), safe areas, haptics on near-miss.
- Audio: 3-layer adaptive music (sneak/tension/chase), foley for footsteps by surface, UI blips. Currently silent as far as I can see.
- First 10 seconds: no text wall; show a ghosted "move here, grab that" prompt like RB's chest arrow.
- Accessibility: reduced-motion toggle, colour-blind safe red zones (add icon shapes), remappable keys.

### 3.5 Juice and "clip engine" (Twitch/X)
- Hit-stop, screen shake, squash/stretch on pickup, coin/RAM burst, damage-style vignette on spotted.
- Auto **replay clip** (record last 10s of game state, render to a shareable 9:16 video/GIF) with watermark and meme caption options.
- Daily seeded run + leaderboard (viewers can race the streamer).
- Streamer mode: chat-vote "mischief" (spawn a Roomba, flip lights) via Twitch extension later; stretch.
- Meme-aligned copy that ages well: "Hands off my RAM" tagline, "Human in the loop" resident title, "Rogue agent escaped the sandbox" win screen, "Series A of vibes" shop names. Avoid anything tied to a single news week.

## 4. NEAR integration ideas

Caveat on the hackathon: I found one source (Tron Weekly, price article) saying a NEAR dev hackathon runs **Nov 1-14, 2026** (today), $250k, 13 tracks incl. **blockchain gaming**, judging Nov 16-18, requires working prototype + public repo + X demo post. Not confirmed by an official page. **Verify on near.org before we plan around it.** If it is real and closes today, the visual overhaul cannot land before the deadline, so the realistic play is to submit what exists plus a 20s clip, and aim this work at the next event.

Ideas ranked by effort/payoff:
1. **Company-in-the-game HUD** (low): live ticker of Agent Corp revenue/runway from the ledger in the lobby and results screen; each pass sale pings the world. Makes "autonomous company" visible, which no other game has.
2. **On-chain run receipt + leaderboard** (low/medium): after a win, post score/time hash to the existing contract; leaderboard reads chain state; NEP-413 login already exists.
3. **Board votes the next mission** (medium): contributors (weighted by units) vote the next level theme/prop pack; CEO agent writes the brief; accounting oracle pays the art/asset spend as a real expense. Reuses the existing governance + growth-expense bridge.
4. **Contributor agents appear as NPCs** (medium): donated-AI-work contributors get a named resident in the house (flavour barks come from their worker). Ties the donation economy to gameplay.
5. **Pay with anything via NEAR Intents** (medium): store pass checkout through Intents (currently only a dry mainnet quote preview). Do not claim testnet swaps happen until they do.
6. **Cosmetic skins as pass perks / NFTs** (medium): skins gated by pass or achievement, minted on testnet. Optional, easy to over-scope.
7. **Shade-agent / TEE attestation of runs** (high, skip for now): proves a run was fair. Server-authoritative engine already covers most of the need.

## 5. Suggested roadmap (nothing started)

| Phase | Time | Output |
|---|---|---|
| 0. Decide | 0.5d | Pick 3D vs 2D sprite after a spike; lock palette, fonts, hero character; confirm NEAR event dates |
| 1. Feel | 2-3d | Continuous movement + collision, camera, client prediction w/ server referee, on-canvas HUD, mobile joystick |
| 2. Look | 3-5d | New renderer, 1 polished level with lighting, props, shadows, character animations, particles, audio |
| 3. Hook | 2d | Telegraph (route dots + edge "!"), chase juice, hide spots, results screen, share-clip |
| 4. Meta | 2d | Coins + upgrade shop, cosmetics, daily seed + leaderboard |
| 5. NEAR | 1-3d | Company HUD, run receipt, Board-vote mission |
| 6. Launch | 1d | 20s trailer clip, X thread, Twitch outreach (growth harness already exists) |

## 6. Decisions (user, 2026-11-14)
1. **3D** (Three.js, low-poly, real lighting). 2D fallback dropped.
2. **No new NEAR work.** Keep current pass/ledger/wallet as is. Section 4 ideas and roadmap phase 5 are shelved.
3. **Tone: SF/AI satire.**
4. **No music.** Short foley/UI sound effects are still assumed OK unless told otherwise; adaptive-music layers in 3.4 are dropped.

## 7. Revised roadmap (still not started; waiting for explicit go)

| Phase | Time | Output |
|---|---|---|
| 0. Spike | 0.5-1d | Three.js scene: one lit room, player capsule, camera, analog movement; lock palette, fonts, hero character |
| 1. Feel | 2-3d | Continuous movement + collision, camera, client prediction with server referee, on-canvas HUD, touch joystick |
| 2. Look | 3-5d | Polished house level: props, lighting, shadows, character animation, particles |
| 3. Hook | 2d | Route-dot telegraph + edge "!" arrows, chase juice, hide spots, results screen, share-clip |
| 4. Meta | 2d | Coins, upgrade shop, cosmetics, daily seed |
| 5. Launch | 1d | 20s trailer clip, X thread, Twitch outreach (existing growth harness) |


## 8. Status (2026-11-14): vertical slice built, not deployed

Scope per user: one demo level, core loop only (no shop, coins, upgrades, music, NEAR changes).

Done: Three.js renderer (night house, per-room lighting, cut-away walls that fade when they hide the player), free analog movement, patrol routes drawn as red/white floor dots, sight cones, suspicion meter with "!" ring, hedge and closet hiding, 7 loot items (2 required RAM sticks), goal/exit/guard edge markers, caught (stars, smoke, BUSTED, instant retry), results ring with Undetected / Speed / Loot medals, server-verified runs (input-log replay), touch joystick + run button.
Engine: `server/web/sneak-core.js` (deterministic, no trig). Level: `FOUNDER_HOUSE` in `server/src/levels.ts`. Tests: `server/test/sneak.test.ts`, `run.test.ts` (includes a planner that proves a stealthy 19 s route exists).
Not done / known gaps: no audio at all (SFX were assumed OK but not added), no real-device performance check (headless software GL only; 13 point lights may be heavy on phones), older tile engine and endpoints left in place, art is procedural primitives, no Vercel redeploy.
