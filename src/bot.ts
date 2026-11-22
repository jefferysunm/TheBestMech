/** Entry point: speak mechfight/1 on stdin/stdout. */
import { draw, log, run, type Hello, type Observation } from "./mechfight.ts"
import { Brain } from "./brain.ts"

/**
 * Exercise the hot code paths on synthetic observations while we still have the generous hello budget,
 * so the JIT has compiled them before the first real 50 ms decision. Uses a throwaway Brain that shares
 * the loaded map; never throws.
 */
function warmup(hello: Hello, brain: Brain, budgetMs = 1500) {
  if (!brain.world || !brain.nav) return
  const t0 = performance.now()
  const cfg: any = hello.config
  const nav = brain.nav
  const zc = cfg.zone.start_center as number[]
  const n = nav.nearestFree(zc[0], zc[1], undefined, 40)
  const x = nav.nodeX(n), y = nav.nodeY(n), z = nav.h[n]
  const fake = new Brain(hello, { world: brain.world, nav: brain.nav })
  const gunStats = { ...cfg.weapons.gun }
  const laserStats = { ...cfg.weapons.laser }
  const stats = { ...cfg.mech }
  for (let k = 0; k < 120 && performance.now() - t0 < budgetMs; k++) {
    const t = k * 0.1
    const ang = k * 0.05
    const ex = x + Math.cos(ang) * 90, ey = y + Math.sin(ang) * 90
    const obs: any = {
      type: "obs", tick: k * 2, t, alive: 16,
      self: {
        id: hello.slot, pos: [x + Math.sin(t) * 3, y, z], vel: [3, 0, 0], aim: [ang, 0], hp: k < 60 ? 1400 : 300, max_hp: 1400,
        energy: 80, max_energy: 100, grounded: true, cubes: 0, upgrades: [], in_zone: true, stats,
        weapons: [
          { kind: "gun", cooldown: 0, ammo: 12 - (k % 12), reload: 0, stats: gunStats },
          { kind: "laser", cooldown: k % 20 < 10 ? 0 : 1, charge: k % 10 < 5 ? 0 : 0.8, stats: laserStats },
        ],
      },
      mechs: k % 30 < 20 ? [{ id: (hello.slot + 1) % 16, kind: "mech", pos: [ex, ey, brain.world.surface(ex, ey)], vel: [5, -3, 0], aim: [ang + Math.PI, 0], hp: 900, max_hp: 1400, cubes: 1, weapons: ["gun", "laser"], charging: k % 7 === 0 }] : [],
      projectiles: [{ id: 1, kind: "mortar", pos: [x + 20, y, z + 30], vel: [-10, 0, 5] }],
      crates: [{ id: 1001, pos: [x - 30, y + 10, brain.world.surface(x - 30, y + 10)], hp: 300 }],
      cubes: [{ id: 5001, pos: [x + 15, y - 15, brain.world.surface(x + 15, y - 15)] }],
      pickups: [{ id: 8001, kind: "lightning", pos: [x - 20, y - 40, brain.world.surface(x - 20, y - 40)] }],
      sounds: [{ kind: "gun", bearing: 1.0, dist: "mid", age: 0.05 }],
      beams: [],
      events: k === 5 ? [{ type: "damaged", amount: 45, weapon: "gun", bearing: ang, by: (hello.slot + 1) % 16 }] : [],
      zone: { center: zc, radius: cfg.zone.start_radius, next_center: [zc[0] + 40, zc[1] - 30], next_radius: cfg.zone.phases[0].radius, shrink_start: 60, shrink_end: 110, dps: cfg.zone.phases[0].dps },
      offer: k === 3 ? { id: 1, expires: 5, choices: [{ id: "armor", name: "", desc: "" }, { id: "plating", name: "", desc: "" }, { id: "servos", name: "", desc: "" }] } : null,
      drops: k > 50 ? [{ id: 20000, pos: [x + 60, y + 20, z], radius: 8, lands_in: 3, capture_s: 4, progress: 0, holder: null }] : [],
    }
    fake.act(obs as Observation)
  }
  // a few long plans across the map
  const b = brain.world.bounds
  for (let k = 0; k < 6 && performance.now() - t0 < budgetMs; k++) {
    nav.plan(b.minX + 60 + k * 120, b.minY + 80, 0, b.maxX - 60 - k * 80, b.maxY - 80, { maxExpand: 30000 })
  }
  draw.clear()
  settle()
  log(`warmup ${(performance.now() - t0).toFixed(0)} ms`)
}

/** collect the garbage from loading + warmup and give background JIT threads a moment, before `ready` */
function settle() {
  const B = (globalThis as any).Bun
  try {
    B?.gc?.(true)
  } catch {}
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
  } catch {}
  try {
    B?.gc?.(true)
  } catch {}
}

run((hello) => {
  const brain = new Brain(hello)
  try {
    warmup(hello, brain)
  } catch (e) {
    log("warmup failed:", e)
  }
  draw.clear()
  return brain
})
