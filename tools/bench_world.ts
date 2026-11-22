import { World } from "../src/world.ts"
import { Nav } from "../src/nav.ts"
const t0 = performance.now()
const w = new World(process.argv[2] ?? "kit/arena")
const t1 = performance.now()
const nav = new Nav(w)
const t2 = performance.now()
console.log(`world ${(t1 - t0).toFixed(0)} ms, nav ${(t2 - t1).toFixed(0)} ms, cells ${w.nx * w.ny}, prism-cells ${w.cellList.length}`)
let solid = 0
for (let c = 0; c < w.nx * w.ny; c++) if (w.wallDist[c] === 0) solid++
console.log("solid cells", solid)
// LOS bench
let rng = 12345
const rnd = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const b = w.bounds
let clear = 0
const t3 = performance.now()
for (let k = 0; k < 20000; k++) {
  const ax = b.minX + rnd() * (b.maxX - b.minX), ay = b.minY + rnd() * (b.maxY - b.minY)
  const ang = rnd() * 6.28, d = 20 + rnd() * 180
  const bx = ax + Math.cos(ang) * d, by = ay + Math.sin(ang) * d
  const az = w.surface(ax, ay) + 8, bz = w.surface(bx, by) + 4.5
  if (w.clear(ax, ay, az, bx, by, bz)) clear++
}
const t4 = performance.now()
console.log(`20000 LOS rays: ${(t4 - t3).toFixed(1)} ms, clear ${clear}`)
const t5 = performance.now()
let can = 0
for (let k = 0; k < 5000; k++) {
  const ax = b.minX + rnd() * (b.maxX - b.minX), ay = b.minY + rnd() * (b.maxY - b.minY)
  const ang = rnd() * 6.28, d = 20 + rnd() * 180
  const bx = ax + Math.cos(ang) * d, by = ay + Math.sin(ang) * d
  if (w.canopyBlocks(ax, ay, w.surface(ax, ay) + 8, bx, by, w.surface(bx, by) + 4.5)) can++
}
console.log(`5000 canopy: ${(performance.now() - t5).toFixed(1)} ms, blocked ${can}`)
// A*
const pairs = [[320, -280, -42, 7], [-400, 300, 400, -250], [-276, 128, 41, -72], [0, 0, 300, 200], [-450, -200, -300, 150]]
for (const [sx, sy, gx, gy] of pairs) {
  const ta = performance.now()
  const p = nav.plan(sx, sy, w.surface(sx, sy), gx, gy, {})
  const tb = performance.now()
  let climbs = 0
  if (p) for (let k = 1; k < p.length; k++) if (p[k][2] - p[k - 1][2] > 2.4) climbs++
  console.log(`A* (${sx},${sy})->(${gx},${gy}): ${(tb - ta).toFixed(1)} ms, expanded ${nav.lastExpanded}, len ${p?.length}, climbs ${climbs}, end ${p && p[p.length - 1].map((v) => v.toFixed(0))}`)
}
