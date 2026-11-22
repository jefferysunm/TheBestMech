/**
 * Run local matches.
 *   bun sim/run.ts --n 4 --seed 1 --roster mine:1,brawler:15 [--verbose] [--png out.png]
 * Prints each match's placements and the mean score (16 - place) per bot kind.
 */
import { Brain } from "../src/brain.ts"
import { Nav } from "../src/nav.ts"
import { World } from "../src/world.ts"
import { writePNG } from "../tools/png.ts"
import { Brawler, Example } from "./opponents.ts"
import { loadBaseHello, Sim, type BotFactory } from "./sim.ts"

const args = process.argv.slice(2)
const opt = (k: string, d: string) => {
  const i = args.indexOf("--" + k)
  return i >= 0 ? args[i + 1] : d
}
const flag = (k: string) => args.includes("--" + k)
const N = Number(opt("n", "1"))
const seed0 = Number(opt("seed", "1"))
const rosterSpec = opt("roster", "mine:1,brawler:15")
const png = opt("png", "")

const hello = loadBaseHello()
const world = new World("kit/arena", hello.config.mech.height, hello.config.mech.step_up)
const nav = new Nav(world)

const kinds: Record<string, (variant: string) => BotFactory> = {
  mine: (v) => (h) => new Brain(h, { world, nav: new Nav(world), name: "mine" + v, aggression: v === "agg" ? 1.6 : v === "timid" ? 0.7 : 1 }),
  brawler: () => (h) => new Brawler(h, nav, 1),
  sloppy: () => (h) => new Brawler(h, nav, 0.5),
  example: () => (h) => new Example(h),
}

function roster(): { name: string; make: BotFactory }[] {
  const out: { name: string; make: BotFactory }[] = []
  for (const part of rosterSpec.split(",")) {
    const [kindv, cnt] = part.split(":")
    const [kind, variant = ""] = kindv.split("/")
    for (let k = 0; k < Number(cnt ?? 1); k++) out.push({ name: kind + (variant ? "/" + variant : ""), make: kinds[kind](variant) })
  }
  return out
}

const scores: Record<string, number[]> = {}
const extra: Record<string, { zone: number; late: number; maxMs: number; kills: number; cubes: number; causes: Record<string, number>; modes: Record<string, number> }> = {}
for (let k = 0; k < N; k++) {
  const seed = seed0 + k
  // shuffle roster order so slots vary
  const r = roster()
  for (let i = r.length - 1; i > 0; i--) {
    const j = (seed * 31 + i * 17) % (i + 1)
    ;[r[i], r[j]] = [r[j], r[i]]
  }
  const sim = new Sim(world, hello, r, seed)
  sim.verbose = flag("verbose")
  const tr = opt("trace", "")
  if (tr) {
    sim.traceId = tr === "mine" ? sim.mechs.findIndex((m) => m.name.startsWith("mine")) : Number(tr)
    sim.traceEvery = Number(opt("every", "10"))
  }
  const t0 = performance.now()
  const res = sim.run()
  const secs = (performance.now() - t0) / 1000
  const line = res.places
    .slice()
    .sort((a, b) => a.place - b.place)
    .map((p) => `${p.place}:${p.name}#${p.id}`)
    .join(" ")
  console.log(`match seed=${seed} dur=${res.duration.toFixed(0)}s wall=${secs.toFixed(1)}s | ${line}`)
  if (flag("verbose") || opt("trace", "")) for (const l of sim.log) console.log("   " + l)
  for (const p of res.places) {
    ;(scores[p.name] ??= []).push(16 - p.place)
    const e = (extra[p.name] ??= { zone: 0, late: 0, maxMs: 0, kills: 0, cubes: 0, causes: {}, modes: {} })
    e.zone += p.zoneDmg
    e.late += p.late
    e.maxMs = Math.max(e.maxMs, p.maxMs)
    e.kills += p.kills
    e.cubes += p.cubes
    const cause = p.place === 1 ? "WIN" : p.cause.split(":")[0] || "alive"
    e.causes[cause] = (e.causes[cause] ?? 0) + 1
    for (const [m, c] of Object.entries(p.modes)) e.modes[m] = (e.modes[m] ?? 0) + c
  }
  if (png && k === 0) drawMatch(sim, png)
}
console.log("\n=== mean score (16 - place) ===")
for (const [name, s] of Object.entries(scores)) {
  const mean = s.reduce((a, b) => a + b, 0) / s.length
  const e = extra[name]
  console.log(`${name.padEnd(12)} n=${String(s.length).padEnd(3)} mean=${mean.toFixed(2)}  kills/m=${(e.kills / s.length).toFixed(2)} cubes/m=${(e.cubes / s.length).toFixed(2)} zoneDmg/m=${(e.zone / s.length).toFixed(0)} late=${e.late} maxMs=${e.maxMs.toFixed(1)} causes=${JSON.stringify(e.causes)}`)
  if (name.startsWith("mine")) {
    const tot = Object.values(e.modes).reduce((a, b) => a + b, 0)
    console.log(`   modes: ${Object.entries(e.modes).sort((a, b) => b[1] - a[1]).map(([m, c]) => `${m} ${((100 * c) / tot).toFixed(0)}%`).join(", ")}`)
  }
}

function drawMatch(sim: Sim, path: string) {
  const w = world
  const W = w.nx, H = w.ny
  const rgb = new Uint8Array(W * H * 3)
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const c = j * W + i
      const o = ((H - 1 - j) * W + i) * 3
      if (w.wallDist[c] === 0) {
        rgb[o] = 110; rgb[o + 1] = 80; rgb[o + 2] = 70
      } else {
        const v = Math.max(0, Math.min(255, 90 + w.terrain[c] * 3))
        rgb[o] = v * 0.45; rgb[o + 1] = v * 0.75; rgb[o + 2] = v * 0.45
      }
    }
  const put = (x: number, y: number, r: number, g: number, b: number, s = 1) => {
    const i = Math.round(x - w.minX), j = Math.round(y - w.minY)
    for (let a = -s; a <= s; a++)
      for (let bb = -s; bb <= s; bb++) {
        const ii = i + a, jj = j + bb
        if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue
        const o = ((H - 1 - jj) * W + ii) * 3
        rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b
      }
  }
  // zone circles
  for (let a = 0; a < 720; a++) {
    const th = (a / 720) * Math.PI * 2
    put(sim.zone.center[0] + Math.cos(th) * sim.zone.radius, sim.zone.center[1] + Math.sin(th) * sim.zone.radius, 255, 255, 255, 0)
  }
  for (const m of sim.mechs) {
    const mine = m.name.startsWith("mine")
    const col: [number, number, number] = mine ? [255, 230, 0] : [255, 60, 60]
    for (const [x, y] of m.trail) put(x, y, col[0], col[1], col[2], mine ? 1 : 0)
    put(m.x, m.y, mine ? 0 : 120, mine ? 0 : 0, mine ? 255 : 0, 3)
  }
  writePNG(path, W, H, rgb)
}
