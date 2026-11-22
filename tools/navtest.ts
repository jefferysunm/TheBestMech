/**
 * Navigation stress test: one bot, no opponents, random start -> random destination (set as the zone's next
 * circle), in the local simulator. Reports how many trips arrive within the time limit and where it got stuck.
 *   bun tools/navtest.ts [trials] [seed]
 */
import { Brain } from "../src/brain.ts"
import { Nav } from "../src/nav.ts"
import { World } from "../src/world.ts"
import { loadBaseHello, Sim } from "../sim/sim.ts"

const trials = Number(process.argv[2] ?? 30)
const seed0 = Number(process.argv[3] ?? 1)
const hello = loadBaseHello()
const world = new World("kit/arena", 9, 1.2)
const idle = { name: "idle", make: () => ({ act: () => ({}) }) }
let ok = 0
const times: number[] = []
const fails: string[] = []
for (let k = 0; k < trials; k++) {
  const seed = seed0 + k
  const sim = new Sim(world, hello, [{ name: "mine", make: (h) => new Brain(h, { world, nav: new Nav(world), lurk: 0 }) }, idle], seed)
  sim.npcs = []
  sim.crates = []
  sim.pickups = []
  const me = sim.mechs[0]
  const other = sim.mechs[1]
  other.x = world.bounds.minX + 40 // park the idle mech in a corner, out of the way
  other.y = world.bounds.minY + 40
  other.z = world.surface(other.x, other.y)
  const g = sim.openGround(0, 0, 450)!
  // a third of starts on a roof, a sixth inside the stadium bowl
  const r = k % 6
  const s = (r < 2 ? sim.openGround(0, 0, 450, true) : r === 2 ? sim.openGround(-276, 128, 45) : null) ?? sim.openGround(0, 0, 450)!
  me.x = s[0]
  me.y = s[1]
  me.z = s[2]
  // zone: huge current circle, next circle tiny around the goal, shrinking soon (but no damage during the test)
  sim.zone = { center: [20, 0], radius: 2000, next_center: [g[0], g[1]], next_radius: 6, shrink_start: 1, shrink_end: 1e6, dps: 0 }
  sim.cfg = { ...sim.cfg, zone: { ...sim.cfg.zone, phases: [] }, drops: undefined }
  const d0 = Math.hypot(g[0] - s[0], g[1] - s[1])
  let arrived = -1
  while (sim.t < 150) {
    sim.step()
    if (Math.hypot(me.x - g[0], me.y - g[1]) < 15) {
      arrived = sim.t
      break
    }
  }
  if (arrived >= 0) {
    ok++
    times.push(arrived / Math.max(1, d0))
  } else fails.push(`seed ${seed}: (${s[0].toFixed(0)},${s[1].toFixed(0)}) -> (${g[0].toFixed(0)},${g[1].toFixed(0)}) d=${d0.toFixed(0)} ended at (${me.x.toFixed(0)},${me.y.toFixed(0)},${me.z.toFixed(0)}) left=${Math.hypot(me.x - g[0], me.y - g[1]).toFixed(0)}m`)
}
times.sort((a, b) => a - b)
console.log(`arrived ${ok}/${trials}; seconds per metre: median ${(times[times.length >> 1] ?? 0).toFixed(3)} p90 ${(times[Math.floor(times.length * 0.9)] ?? 0).toFixed(3)} (walk speed = ${(1 / 11.7).toFixed(3)})`)
for (const f of fails) console.log("  FAIL " + f)
