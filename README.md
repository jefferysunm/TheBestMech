# TheBestMech

A bot for the Mech Royale track (`mechfight/1` protocol): a 16-mech free-for-all on the Ohio State campus where
**placement** is what scores. The bot plays to survive: it stays ahead of the zone, avoids even fights, breaks line of sight when it's losing,
and spends the quiet time collecting what makes it harder to kill (a laser, cubes, upgrades, supply drops).

Written in TypeScript and run with Bun. It has no dependencies. The `Dockerfile` at the top level is the submission image.

## Layout

| Path | What it is |
| --- | --- |
| `Dockerfile` | Submission image (`oven/bun:1.4.4-slim`, entrypoint `bun /bot/src/bot.ts`). |
| `src/bot.ts` | Entry point: loads the map, warms the JIT up during `hello`, runs the protocol loop. |
| `src/mechfight.ts` | The kit's protocol wrapper (unchanged). |
| `src/world.ts` | Map model: terrain heights, prisms rasterized to a 1 m grid, line-of-sight raycasts, tree canopy, and a 2.5D "standable surface". |
| `src/nav.ts` | 2 m navigation grid with A*: walk edges, hop edges, and jet-climb edges whose cost depends on height; free drops; zone and wall-clearance costs. |
| `src/brain.ts` | Decisions: tracking, zone timing, fight-or-flee, cover search, combat movement, aiming (gun lead, laser charge/release, lightning cone, mortar ballistics), loot, upgrades, supply drops. |
| `sim/` | An approximate local server (physics, vision, sounds, weapons, NPCs, crates, loot, zone, drops) plus stand-in opponents, for testing. |
| `tools/` | Benchmarks, A/B comparison, latency check, map rendering. |
| `kit/` | The official kit's map, schema, protocol docs and conformance check (for local testing; not in the image). |

## How it plays

- **Zone first.** It works out when the shrinking edge will reach it and how long the trip to safety takes, and leaves in time. It routes
  around the zone with A* and keeps energy in reserve for any wall it has to jet over on the way.
- **Pick fights.** It estimates time-to-kill both ways from the weapons each side holds, HP, cubes and range. It fights when it is clearly ahead.
  Otherwise it **disengages** to a spot hidden from everyone who can see it, including attackers it can only hear or feel (hits from an
  unseen shooter put a "ghost" at the hit bearing). Mode hysteresis stops it flip-flopping between cover and exposure.
- **Shoot well.** The gun leads moving targets and holds fire at long range where a dodge makes a hit unlikely. The laser charges only with a clear
  shot and releases when on target. Lightning fires only when the target is inside the cone. The mortar solves the ballistic arc, lobs over buildings, and never
  lands near itself. In fights it strafes with irregular timing to beat lead prediction, and it dodges incoming mortar shells.
- **Get stronger quietly.** Weapon priority is laser > lightning > mortar (the gun is kept). It collects cubes, shoots crates when nobody is
  around, takes supply drops when they aren't contested, and picks upgrades by a survival-first list (plating, armor, laser damage, nanites, ...).
- **Timing.** Typical decisions take 0.3–3 ms. A* is capped and unreachable goals are blacklisted. The JIT is warmed up and the GC settled
  before `ready`, so even the first observation is fast in the 1-CPU sandbox.

## Testing

```bash
python3 kit/check/check.py -- bun src/bot.ts
```

```bash
docker build -t thebestmech .
```

```bash
python3 kit/check/check.py --map-dir /arena -- docker run --rm -i --network none --cpus 1 --memory 512m --read-only --tmpfs /tmp:rw,size=64m --user 65534:65534 -v "$PWD/kit/arena:/arena:ro" thebestmech
```

Local matches against stand-in opponents (`mine`, `brawler`, `sloppy`, `example`):

```bash
bun sim/run.ts --n 10 --seed 1 --roster mine:1,brawler:15
```

```bash
tools/ab.sh HEAD 40
```

The second command compares the committed bot against the working tree on the same 160 seeds. `--trace mine --every 4` on `sim/run.ts` prints what the bot
saw and did, and `MECH_PROFILE=1` logs slow decisions.

Navigation stress test (random trips from ground, roof and stadium starts) and answer-time check in the 1-CPU sandbox:

```bash
bun tools/navtest.ts 40 1
```

```bash
python3 tools/latency.py --map-dir /arena -- docker run --rm -i --network none --cpus 1 --memory 512m --read-only --tmpfs /tmp:rw,size=64m --user 65534:65534 -v "$PWD/kit/arena:/arena:ro" thebestmech
```

### Local results (simulator, not the real server)

| Setup | Mean score (16 − place) | Notes |
| --- | --- | --- |
| 1 bot vs 15 `brawler` (160 matches, fresh seeds) | 12.4 | top 3 in 74%, bottom 4 in 11%; an average bot scores 7.5 |
| 1 bot vs 5 `brawler` + 5 `sloppy` + 5 `example` (40 matches) | 12.75 | |
| Navigation stress test (240 trips, incl. roof/stadium starts) | 240/240 arrived | median pace ≈ walking speed over the straight-line distance |
| Decision time in the 1-CPU sandbox | max ≈ 3–5 ms | budget is 50 ms |

The simulator follows `protocol.md` but it is not the real server: treat its numbers as relative, not absolute.
