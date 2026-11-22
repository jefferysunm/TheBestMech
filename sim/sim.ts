/**
 * An approximate mechfight/1 server for local testing. It follows protocol.md as closely as is practical:
 * lockstep decisions every 2 ticks, physics with wall sliding / step-up / jets, vision with FOV, near range,
 * canopy and 5 s memory, sounds with bearing noise, the four weapons, NPC drones, crates, cubes, weapon loot,
 * upgrades, supply drops and the zone. It is not the real server: use it to find bugs and compare variants.
 */
import { gunzipSync } from "node:zlib"
import { readFileSync } from "node:fs"
import type { Hello, Observation } from "../src/mechfight.ts"
import type { World } from "../src/world.ts"
import { angDiff, Rng, wrap, zoneAt } from "../src/util.ts"
import { draw } from "../src/mechfight.ts"

export type BotLike = { name?: string; act(obs: Observation): any }
export type BotFactory = (hello: Hello) => BotLike

export function loadBaseHello(path = "kit/check/stream.jsonl.gz"): Hello {
  const txt = gunzipSync(readFileSync(path)).toString("utf8")
  return JSON.parse(txt.split("\n")[0])
}

type WeaponState = { kind: string; cooldown: number; ammo: number; reload: number; charge: number; fullHeld: number; equipUntil: number; release: boolean }

type Mech = {
  id: number
  name: string
  bot: BotLike
  x: number; y: number; z: number
  vx: number; vy: number; vz: number
  yaw: number; pitch: number
  cmd: any
  hp: number
  energy: number
  lastSpend: number
  grounded: boolean
  cubes: number
  upgrades: string[]
  upCount: Record<string, number>
  weapons: (WeaponState | null)[]
  alive: boolean
  place: number
  kills: number
  lastHurt: number
  lastDeal: number
  shortUntil: number
  memory: Map<number, number> // id -> last seen t
  events: any[]
  offers: { id: number; choices: string[]; expires: number }[]
  offerSeq: number
  thresholdsHit: number
  lastObsT: number
  heardFrom: number
  stats: Record<string, number>
  wstats: Record<string, Record<string, number>>
  stepAcc: number
  // diagnostics
  timeMs: number[]
  late: number
  zoneDmg: number
  dmgTaken: number
  dmgDealt: number
  deathCause: string
  maxMs: number
  modes: Record<string, number>
  trail: [number, number][]
}

type Npc = { id: number; x: number; y: number; z: number; vx: number; vy: number; hx: number; hy: number; hp: number; target: number | null; cooldown: number; gx: number; gy: number; aggroBy: number | null; yaw: number }
type Proj = { id: number; kind: string; owner: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; dist: number; range: number; dmg: number; ttl: number }
type Item = { id: number; x: number; y: number; z: number; hp?: number; kind?: string; ammo?: number }
type Sound = { t: number; kind: string; x: number; y: number; src: number }
type Drop = { id: number; x: number; y: number; z: number; landT: number; holder: number | null; progress: number; taken: boolean }

export type SimResult = { places: { id: number; name: string; place: number; kills: number; cubes: number; dmgTaken: number; dmgDealt: number; zoneDmg: number; cause: string; maxMs: number; late: number; modes: Record<string, number> }[]; duration: number; mechs: Mech[] }

export class Sim {
  cfg: any
  rng: Rng
  t = 0
  tick = 0
  mechs: Mech[] = []
  npcs: Npc[] = []
  crates: Item[] = []
  cubes: Item[] = []
  pickups: Item[] = []
  projs: Proj[] = []
  sounds: Sound[] = []
  beams: { t: number; by: number; kind: string; path: number[][] }[] = []
  drops: Drop[] = []
  nextId = 1
  zone: { center: number[]; radius: number; next_center: number[]; next_radius: number; shrink_start: number; shrink_end: number; dps: number }
  phase = 0
  deadThisTick: Mech[] = []
  verbose = false
  log: string[] = []
  traceId = -1
  traceEvery = 2

  constructor(public world: World, public hello: Hello, factories: { name: string; make: BotFactory }[], seed: number) {
    this.cfg = hello.config
    this.rng = new Rng(seed)
    const Z = this.cfg.zone
    // zone phases: next circle centers random, each inside the previous
    const p0 = Z.phases[0]
    const nc = this.randomInside(Z.start_center[0], Z.start_center[1], Z.start_radius - p0.radius)
    this.zone = { center: [...Z.start_center], radius: Z.start_radius, next_center: nc, next_radius: p0.radius, shrink_start: p0.hold_s, shrink_end: p0.hold_s + p0.shrink_s, dps: p0.dps }
    this.spawnAll(factories, seed)
  }

  randomInside(cx: number, cy: number, r: number): number[] {
    for (let k = 0; k < 200; k++) {
      const a = this.rng.next() * Math.PI * 2, d = Math.sqrt(this.rng.next()) * r
      const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d
      if (this.world.inBounds(x, y, 40)) return [x, y]
    }
    return [cx, cy]
  }

  openGround(cx: number, cy: number, r: number, roof = false): number[] | null {
    const w = this.world
    for (let k = 0; k < 400; k++) {
      const a = this.rng.next() * Math.PI * 2, d = Math.sqrt(this.rng.next()) * r
      const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d
      if (!w.inBounds(x, y, this.cfg.match.arena_margin ?? 30)) continue
      const c = w.cellOf(x, y)
      const isRoof = w.wallDist[c] === 0
      if (roof !== isRoof) continue
      if (!roof && w.wallDist[c] < 4) continue
      if (roof && w.surf[c] - w.terrain[c] > 60) continue
      return [x, y, w.surface(x, y)]
    }
    return null
  }

  mechStats(m: Mech) {
    const base = { ...this.cfg.mech }
    const W: Record<string, Record<string, number>> = {}
    for (const k of ["gun", "mortar", "laser", "lightning"]) W[k] = { ...this.cfg.weapons[k] }
    for (const u of m.upgrades) {
      const def = this.cfg.upgrades.find((d: any) => d.id === u)
      if (!def) continue
      for (const e of def.effects) {
        const [a, b, c] = e.path.split(".")
        const obj = a === "mech" ? base : W[b]
        const key = a === "mech" ? b : c
        if (e.mul !== undefined) obj[key] *= e.mul
        if (e.add !== undefined) obj[key] = (obj[key] ?? 0) + e.add
      }
    }
    const s = 1 + this.cfg.cubes.size_per_cube * m.cubes
    base.radius *= s
    base.height *= s
    base.eye_height *= s
    base.muzzle_height *= s
    base.hp = base.hp * (1 + this.cfg.cubes.hp_per_cube * Math.min(m.cubes, this.cfg.cubes.stat_cap))
    m.stats = base
    m.wstats = W
  }

  spawnAll(factories: { name: string; make: BotFactory }[], seed: number) {
    const C = this.cfg
    const sep = C.match.spawn_min_separation
    const spawnR = this.zone.radius * C.match.spawn_zone_fraction
    const pts: number[][] = []
    for (let i = 0; i < factories.length; i++) {
      let best: number[] | null = null
      for (let k = 0; k < 300; k++) {
        const p = this.openGround(this.zone.center[0], this.zone.center[1], spawnR)
        if (!p) continue
        const ok = pts.every((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) > sep * (k < 200 ? 1 : 0.6))
        best = p
        if (ok) break
      }
      pts.push(best!)
    }
    for (let i = 0; i < factories.length; i++) {
      const p = pts[i]
      const hello: Hello = JSON.parse(JSON.stringify(this.hello))
      hello.slot = i
      hello.seed = (seed * 7919 + i * 104729) >>> 0
      const bot = factories[i].make(hello)
      const m: Mech = {
        id: i, name: factories[i].name, bot,
        x: p[0], y: p[1], z: p[2], vx: 0, vy: 0, vz: 0,
        yaw: this.rng.range(-Math.PI, Math.PI), pitch: 0, cmd: {},
        hp: C.mech.hp, energy: C.mech.energy, lastSpend: -99, grounded: true,
        cubes: 0, upgrades: [], upCount: {}, weapons: [this.newWeapon("gun"), null],
        alive: true, place: 0, kills: 0, lastHurt: -99, lastDeal: -99, shortUntil: -99,
        memory: new Map(), events: [], offers: [], offerSeq: 0, thresholdsHit: 0, lastObsT: 0, heardFrom: 0,
        stats: {}, wstats: {}, stepAcc: 0, timeMs: [], late: 0, zoneDmg: 0, dmgTaken: 0, dmgDealt: 0, deathCause: "", maxMs: 0, modes: {}, trail: [],
      }
      m.yaw = Math.atan2(this.zone.next_center[1] - p[1], this.zone.next_center[0] - p[0])
      this.mechStats(m)
      m.hp = m.stats.hp
      this.mechs.push(m)
    }
    // NPCs
    for (let k = 0; k < C.npc.count; k++) {
      const p = this.openGround(this.zone.center[0], this.zone.center[1], this.zone.radius * 0.85)
      if (!p) continue
      this.npcs.push({ id: 100 + k, x: p[0], y: p[1], z: p[2], vx: 0, vy: 0, hx: p[0], hy: p[1], hp: C.npc.hp, target: null, cooldown: 0, gx: p[0], gy: p[1], aggroBy: null, yaw: 0 })
    }
    // crates
    for (let k = 0; k < C.crates.count; k++) {
      const roof = this.rng.next() < C.crates.roof_fraction
      const p = this.openGround(this.zone.center[0], this.zone.center[1], this.zone.radius * 0.9, roof) ?? this.openGround(this.zone.center[0], this.zone.center[1], this.zone.radius * 0.9)
      if (p) this.crates.push({ id: 1000 + k, x: p[0], y: p[1], z: p[2], hp: C.crates.hp })
    }
    // floor loot
    const wts = C.loot.weights
    const kinds = ["gun", "mortar", "laser", "lightning"]
    const tot = kinds.reduce((a, k) => a + (wts[k] ?? 0), 0)
    for (let k = 0; k < C.loot.floor_count; k++) {
      const roof = this.rng.next() < C.loot.floor_roof_fraction
      const p = this.openGround(this.zone.center[0], this.zone.center[1], this.zone.radius * 0.9, roof) ?? this.openGround(this.zone.center[0], this.zone.center[1], this.zone.radius * 0.9)
      if (!p) continue
      let r = this.rng.next() * tot
      let kind = "laser"
      for (const kk of kinds) {
        r -= wts[kk] ?? 0
        if (r <= 0) {
          kind = kk
          break
        }
      }
      this.pickups.push({ id: 8000 + this.pickups.length + k * 0, x: p[0], y: p[1], z: p[2], kind })
    }
    this.pickups.forEach((p, i) => (p.id = 8000 + i))
    this.nextId = 8000 + this.pickups.length
  }

  newWeapon(kind: string, ammo?: number): WeaponState {
    const ws = this.cfg.weapons[kind]
    return { kind, cooldown: 0, ammo: kind === "gun" ? (ammo ?? ws.mag) : 0, reload: 0, charge: 0, fullHeld: 0, equipUntil: 0, release: false }
  }

  // ------------------------------------------------------------------ vision
  canSee(m: Mech, x: number, y: number, z: number, h: number): boolean {
    const v = this.cfg.vision
    const eye = m.z + m.stats.eye_height
    const d = Math.hypot(x - m.x, y - m.y)
    const near = v.near_range + (m.stats.near_range_bonus ?? 0)
    const range = v.range + (m.stats.vision_bonus ?? 0)
    if (d > range) return false
    const w = this.world
    if (d <= near) {
      return w.clear(m.x, m.y, eye, x, y, z + h * 0.5) || w.clear(m.x, m.y, eye, x, y, z + h)
    }
    const b = Math.atan2(y - m.y, x - m.x)
    if (Math.abs(angDiff(b, m.yaw)) > (v.fov_deg * Math.PI) / 360) return false
    for (const zz of [z + h * 0.5, z + h]) {
      if (w.clear(m.x, m.y, eye, x, y, zz) && !(v.canopy_blocks && w.canopyBlocks(m.x, m.y, eye, x, y, zz))) return true
    }
    return false
  }

  // ------------------------------------------------------------------ observations
  observe(m: Mech): Observation {
    const C = this.cfg
    const t = this.t
    const mechs: any[] = []
    for (const o of this.mechs) {
      if (o === m || !o.alive) continue
      const seen = this.canSee(m, o.x, o.y, o.z, o.stats.height)
      if (seen) m.memory.set(o.id, t)
      const last = m.memory.get(o.id)
      if (seen || (last !== undefined && t - last <= C.vision.memory_s)) {
        const laser = o.weapons.find((w) => w && w.kind === "laser")
        mechs.push({
          id: o.id, kind: "mech", pos: [o.x, o.y, o.z], vel: [o.vx, o.vy, o.vz], aim: [o.yaw, o.pitch],
          hp: Math.round(o.hp * 10) / 10, max_hp: o.stats.hp, cubes: o.cubes,
          weapons: o.weapons.filter((w) => w).map((w) => w!.kind), charging: !!(laser && laser.charge > 0),
        })
      }
    }
    for (const n of this.npcs) {
      if (n.hp <= 0) continue
      const seen = this.canSee(m, n.x, n.y, n.z, C.npc.height)
      if (seen) m.memory.set(n.id, t)
      const last = m.memory.get(n.id)
      if (seen || (last !== undefined && t - last <= C.vision.memory_s)) mechs.push({ id: n.id, kind: "npc", pos: [n.x, n.y, n.z], vel: [n.vx, n.vy, 0], aim: [n.yaw, 0], hp: n.hp, max_hp: C.npc.hp })
    }
    const vis = (it: Item, h: number) => this.canSee(m, it.x, it.y, it.z, h)
    const crates = this.crates.filter((c) => vis(c, C.crates.height)).map((c) => ({ id: c.id, pos: [c.x, c.y, c.z], hp: c.hp }))
    const cubes = this.cubes.filter((c) => vis(c, 1)).map((c) => ({ id: c.id, pos: [c.x, c.y, c.z] }))
    const pickups = this.pickups.filter((c) => vis(c, 1)).map((c) => ({ id: c.id, kind: c.kind, pos: [c.x, c.y, c.z] }))
    const projectiles = this.projs
      .filter((p) => p.owner !== m.id && this.canSee(m, p.x, p.y, p.z, 0.1))
      .map((p) => ({ id: p.id, kind: p.kind, pos: [p.x, p.y, p.z], vel: [p.vx, p.vy, p.vz] }))
    const sounds: any[] = []
    const noise = ((C.sound.bearing_noise_deg * Math.PI) / 180) * (m.stats.hearing ?? 1)
    for (const s of this.sounds) {
      if (s.t <= m.lastObsT - 1e-9 || s.src === m.id) continue
      const d = Math.hypot(s.x - m.x, s.y - m.y)
      if (d > (C.sound.range[s.kind] ?? 100)) continue
      sounds.push({ kind: s.kind, bearing: wrap(Math.atan2(s.y - m.y, s.x - m.x) + this.rng.gauss() * noise), dist: d < C.sound.near ? "near" : d < C.sound.mid ? "mid" : "far", age: Math.round((t - s.t) * 100) / 100 })
    }
    const beams = this.beams
      .filter((b) => b.t > m.lastObsT - 1e-9 && b.by !== m.id && b.path.some((p) => this.canSee(m, p[0], p[1], p[2] - 0.5, 1)))
      .map((b) => ({ by: b.by, kind: b.kind, path: b.path, age: Math.round((t - b.t) * 100) / 100 }))
    m.lastObsT = t
    // offers
    let offer: any = null
    if (m.offers.length) {
      const o = m.offers[0]
      offer = { id: o.id, expires: o.expires, choices: o.choices.map((id) => { const d = C.upgrades.find((u: any) => u.id === id); return { id, name: d.name, desc: d.desc } }) }
    }
    const events = m.events
    m.events = []
    const drops = this.drops.filter((d) => !d.taken).map((d) => ({ id: d.id, pos: [d.x, d.y, d.z], radius: C.drops.radius, lands_in: Math.max(0, Math.round((d.landT - t) * 10) / 10), capture_s: C.drops.capture_s, progress: d.progress, holder: d.holder }))
    const zNow = zoneAt(this.zone, t)
    return {
      type: "obs", tick: this.tick, t: Math.round(t * 100) / 100, alive: this.mechs.filter((x) => x.alive).length,
      self: {
        id: m.id, pos: [m.x, m.y, m.z], vel: [m.vx, m.vy, m.vz], aim: [m.yaw, m.pitch], hp: m.hp, max_hp: m.stats.hp,
        energy: m.energy, max_energy: m.stats.energy, grounded: m.grounded, cubes: m.cubes, upgrades: [...m.upgrades],
        weapons: m.weapons.map((w) => w ? { kind: w.kind, cooldown: Math.max(0, w.cooldown, w.equipUntil - t), stats: { ...m.wstats[w.kind] }, ...(w.kind === "gun" ? { ammo: w.ammo, reload: w.reload } : {}), ...(w.kind === "laser" ? { charge: w.charge } : {}) } : null) as any,
        in_zone: Math.hypot(m.x - zNow.x, m.y - zNow.y) <= zNow.r, stats: { ...m.stats },
      },
      mechs, projectiles, crates, cubes, pickups, sounds, beams, events, zone: { ...this.zone }, offer, drops,
    } as any
  }

  sound(kind: string, x: number, y: number, src: number) {
    this.sounds.push({ t: this.t, kind, x, y, src })
  }

  // ------------------------------------------------------------------ damage
  damage(victim: Mech | Npc | Item, amount: number, weapon: string, attacker: Mech | Npc | null, fromX: number, fromY: number, effect?: string) {
    const C = this.cfg
    if ("bot" in victim) {
      const v = victim as Mech
      if (!v.alive) return
      let amt = amount
      let rear = false
      if (attacker && weapon !== "zone") {
        const b = Math.atan2(fromY - v.y, fromX - v.x)
        if (Math.abs(angDiff(b, v.yaw)) > ((v.stats.front_arc_deg ?? 180) * Math.PI) / 360) {
          rear = true
          amt *= v.stats.rear_mult ?? 1.5
        }
        amt *= 1 - Math.min(0.9, v.stats.armor ?? 0)
      }
      amt = Math.round(amt * 10) / 10
      v.hp -= amt
      v.dmgTaken += amt
      if (weapon === "zone") v.zoneDmg += amt
      v.lastHurt = this.t
      const by = attacker && "bot" in attacker ? (attacker as Mech).id : attacker ? (attacker as Npc).id : null
      v.events.push({ type: "damaged", amount: amt, weapon, bearing: attacker || weapon !== "zone" ? Math.atan2(fromY - v.y, fromX - v.x) : null, by, ...(rear ? { rear: true } : {}) })
      if (attacker && "bot" in attacker) {
        const a = attacker as Mech
        a.lastDeal = this.t
        a.dmgDealt += amt
        a.events.push({ type: "hit", target: v.id, amount: amt, weapon, ...(effect ? { effect } : {}), ...(rear ? { rear: true } : {}) })
      }
      if (v.hp <= 0) {
        v.hp = 0
        v.alive = false
        v.deathCause = weapon + (by !== null ? `:${by}` : "")
        this.deadThisTick.push(v)
        this.sound("death", v.x, v.y, v.id)
        if (attacker && "bot" in attacker) {
          ;(attacker as Mech).kills++
          ;(attacker as Mech).events.push({ type: "kill", target: v.id })
        }
        // drops
        const n = v.cubes + C.cubes.death_drop_extra
        for (let k = 0; k < n; k++) this.cubes.push({ id: 5000 + this.nextId++, x: v.x + this.rng.range(-3, 3), y: v.y + this.rng.range(-3, 3), z: v.z })
        for (const w of v.weapons) if (w && w.kind !== "gun") this.pickups.push({ id: this.nextId++, x: v.x + this.rng.range(-2, 2), y: v.y + this.rng.range(-2, 2), z: v.z, kind: w.kind })
      }
    } else if ("hx" in victim) {
      const n = victim as Npc
      if (n.hp <= 0) return
      n.hp -= amount
      if (attacker && "bot" in attacker) {
        const a = attacker as Mech
        n.aggroBy = a.id
        a.events.push({ type: "hit", target: n.id, amount, weapon })
      }
      if (n.hp <= 0) {
        for (let k = 0; k < C.npc.cubes; k++) this.cubes.push({ id: 5000 + this.nextId++, x: n.x + this.rng.range(-2, 2), y: n.y + this.rng.range(-2, 2), z: n.z })
      }
    } else {
      const c = victim as Item
      if ((c.hp ?? 0) <= 0) return
      c.hp! -= amount
      if (attacker && "bot" in attacker) (attacker as Mech).events.push({ type: "hit", target: c.id, amount, weapon })
      if (c.hp! <= 0) {
        this.sound("crate", c.x, c.y, -1)
        for (let k = 0; k < C.crates.cubes; k++) this.cubes.push({ id: 5000 + this.nextId++, x: c.x, y: c.y, z: c.z })
        if (this.rng.next() < C.loot.crate_weapon_chance) {
          const kinds = ["mortar", "laser", "lightning"]
          this.pickups.push({ id: this.nextId++, x: c.x + 1, y: c.y, z: c.z, kind: kinds[Math.floor(this.rng.next() * 3)] })
        }
      }
    }
  }

  dmgMult(a: Mech) {
    return 1 + this.cfg.cubes.damage_per_cube * Math.min(a.cubes, this.cfg.cubes.stat_cap)
  }

  /** first entity hit along a segment (mechs, npcs, crates), excluding `skip` */
  rayEntities(ax: number, ay: number, az: number, dx: number, dy: number, dz: number, len: number, skip: number, extraR = 0): { ent: any; t: number } | null {
    let best: any = null, bt = len
    const test = (ent: any, x: number, y: number, z0: number, h: number, r: number) => {
      // ray vs vertical cylinder
      const fx = ax - x, fy = ay - y
      const a = dx * dx + dy * dy
      const b = 2 * (fx * dx + fy * dy)
      const c = fx * fx + fy * fy - (r + extraR) * (r + extraR)
      let t0: number
      if (a < 1e-9) {
        if (c > 0) return
        t0 = 0
      } else {
        const disc = b * b - 4 * a * c
        if (disc < 0) return
        const s = Math.sqrt(disc)
        t0 = (-b - s) / (2 * a)
        const t1 = (-b + s) / (2 * a)
        if (t1 < 0) return
        if (t0 < 0) t0 = 0
        // vertical check over [t0,t1]
        const za = az + dz * t0, zb = az + dz * t1
        if (Math.max(za, zb) < z0 || Math.min(za, zb) > z0 + h) return
        if (za < z0 || za > z0 + h) {
          // entering through top/bottom
          const tz = dz !== 0 ? ((za < z0 ? z0 : z0 + h) - az) / dz : t0
          t0 = Math.max(t0, tz)
        }
      }
      if (t0 < bt) {
        bt = t0
        best = ent
      }
    }
    for (const m of this.mechs) if (m.alive && m.id !== skip) test(m, m.x, m.y, m.z, m.stats.height, m.stats.radius)
    for (const n of this.npcs) if (n.hp > 0 && n.id !== skip) test(n, n.x, n.y, n.z, this.cfg.npc.height, this.cfg.npc.radius)
    for (const c of this.crates) if ((c.hp ?? 0) > 0) test(c, c.x, c.y, c.z, this.cfg.crates.height, this.cfg.crates.radius)
    return best ? { ent: best, t: bt } : null
  }

  // ------------------------------------------------------------------ step
  decide() {
    for (const m of this.mechs) {
      if (!m.alive) continue
      const obs = this.observe(m)
      const t0 = performance.now()
      let a: any = {}
      draw.clear()
      try {
        a = m.bot.act(obs) ?? {}
      } catch (e) {
        console.error(`bot ${m.id} threw`, e)
        a = {}
      }
      const dbg = draw.take()
      if (dbg && !a.debug) a.debug = dbg
      if (this.traceId === m.id && this.tick % this.traceEvery === 0) {
        const vis = obs.mechs.filter((o: any) => o.kind === "mech").map((o: any) => `#${o.id}@${Math.round(Math.hypot(o.pos[0] - m.x, o.pos[1] - m.y))}m/${Math.round(o.hp)}${o.weapons?.includes("laser") ? "L" : ""}`).join(",")
        const ev = obs.events.filter((e: any) => e.type !== "hit" || e.target < 100).map((e: any) => e.type === "damaged" ? `-${Math.round(e.amount)}${e.weapon[0]}${e.by ?? ""}${e.rear ? "R" : ""}` : e.type === "hit" ? `+${Math.round(e.amount)}>${e.target}` : e.type).join(" ")
        const ws = obs.self.weapons.map((w: any) => w ? w.kind[0] + (w.kind === "gun" ? w.ammo : w.kind === "laser" ? (w.charge ?? 0).toFixed(1) : "") : "-").join("")
        this.log.push(`[${m.id}] t=${this.t.toFixed(1)} ${a.debug?.label ?? ""} pos=${m.x.toFixed(0)},${m.y.toFixed(0)},${m.z.toFixed(0)} v=${Math.hypot(m.vx, m.vy).toFixed(1)} e=${m.energy.toFixed(0)} w=${ws} aim=${m.yaw.toFixed(2)} fire=${JSON.stringify(a.fire ?? [])} mv=${(a.move ?? [0, 0]).map((v: number) => v.toFixed(1))}${a.boost ? "B" : ""}${a.jump ? "J" : ""} | ${vis} | ${ev}`)
      }
      const ms = performance.now() - t0
      m.maxMs = Math.max(m.maxMs, ms)
      if (ms > 45) m.late++
      const label = a.debug?.label
      if (label) {
        const md = String(label).split(/[ :]/)[0]
        m.modes[md] = (m.modes[md] ?? 0) + 1
      }
      this.applyAction(m, a)
      if (this.tick % 20 === 0) m.trail.push([m.x, m.y])
    }
  }

  applyAction(m: Mech, a: any) {
    const C = this.cfg
    m.cmd = { move: a.move ?? [0, 0], boost: !!a.boost, aim: a.aim ?? m.cmd.aim ?? [m.yaw, m.pitch], fire: a.fire ?? [false, false] }
    if (a.jump && m.grounded) {
      m.vz = m.stats.jump_speed
      m.grounded = false
    }
    if (a.reload) {
      const g = m.weapons.find((w) => w && w.kind === "gun")
      if (g && g.reload <= 0 && g.ammo < m.wstats.gun.mag) {
        g.reload = m.wstats.gun.reload
        this.sound("reload", m.x, m.y, m.id)
      }
    }
    if (a.pick !== undefined && m.offers.length) {
      const o = m.offers.shift()!
      const id = o.choices[Math.max(0, Math.min(o.choices.length - 1, a.pick | 0))]
      this.applyUpgrade(m, id)
    }
    if (a.take !== undefined) {
      const p = this.pickups.find((q) => q.id === a.take)
      if (!p) m.events.push({ type: "take_failed", id: a.take, reason: "gone" })
      else if (Math.hypot(p.x - m.x, p.y - m.y) > C.loot.pickup_radius || Math.abs(p.z - m.z) > 4) m.events.push({ type: "take_failed", id: p.id, reason: "range" })
      else if (m.weapons.some((w) => w && w.kind === p.kind)) m.events.push({ type: "take_failed", id: p.id, reason: "have" })
      else {
        let slot = m.weapons.findIndex((w) => !w)
        if (a.drop === 0 || a.drop === 1) slot = a.drop
        if (slot < 0) m.events.push({ type: "take_failed", id: p.id, reason: "full" })
        else if (m.weapons[slot] && m.weapons[slot]!.kind === "laser" && m.weapons[slot]!.charge > 0) m.events.push({ type: "take_failed", id: p.id, reason: "busy" })
        else {
          const old = m.weapons[slot]
          if (old) {
            const nid = this.nextId++
            this.pickups.push({ id: nid, x: m.x, y: m.y, z: m.z, kind: old.kind, ammo: old.ammo })
            m.events.push({ type: "dropped", id: nid, kind: old.kind, slot })
          }
          this.pickups = this.pickups.filter((q) => q !== p)
          const w = this.newWeapon(p.kind!, p.ammo)
          w.equipUntil = this.t + Math.max(C.loot.equip_s, m.wstats[p.kind!].cooldown ?? 0)
          m.weapons[slot] = w
          m.events.push({ type: "took", id: p.id, kind: p.kind, slot })
        }
      }
    } else if (a.drop === 0 || a.drop === 1) {
      const old = m.weapons[a.drop]
      if (old && !(old.kind === "laser" && old.charge > 0)) {
        const nid = this.nextId++
        this.pickups.push({ id: nid, x: m.x, y: m.y, z: m.z, kind: old.kind, ammo: old.ammo })
        m.events.push({ type: "dropped", id: nid, kind: old.kind, slot: a.drop })
        m.weapons[a.drop] = null
      }
    }
  }

  applyUpgrade(m: Mech, id: string) {
    const before = m.stats.hp
    m.upgrades.push(id)
    m.upCount[id] = (m.upCount[id] ?? 0) + 1
    this.mechStats(m)
    if (m.stats.hp > before) m.hp += m.stats.hp - before
    m.events.push({ type: "upgrade", id })
  }

  makeOffer(m: Mech) {
    const C = this.cfg
    const kinds = new Set(m.weapons.filter((w) => w).map((w) => w!.kind))
    const avail = C.upgrades.filter((u: any) => (m.upCount[u.id] ?? 0) < u.max && (!u.requires || kinds.has(u.requires))).map((u: any) => u.id)
    const choices: string[] = []
    while (choices.length < 3 && avail.length) choices.push(avail.splice(Math.floor(this.rng.next() * avail.length), 1)[0])
    if (choices.length) m.offers.push({ id: ++m.offerSeq, choices, expires: this.t + C.bot.offer_timeout_s })
  }

  addCubes(m: Mech, n: number) {
    const before = m.stats.hp
    m.cubes += n
    this.mechStats(m)
    m.hp += Math.max(0, m.stats.hp - before)
    const th = this.cfg.cubes.upgrade_thresholds
    while (m.thresholdsHit < th.length && m.cubes >= th[m.thresholdsHit]) {
      m.thresholdsHit++
      this.makeOffer(m)
    }
  }

  physics(m: Mech, dt: number) {
    const S = m.stats
    const w = this.world
    const C = this.cfg
    // aim slew
    const [cy, cp] = m.cmd.aim ?? [m.yaw, m.pitch]
    const dy = angDiff(cy, m.yaw)
    const maxY = S.turn_rate * dt
    m.yaw = wrap(m.yaw + Math.max(-maxY, Math.min(maxY, dy)))
    const tp = Math.max(S.min_pitch, Math.min(S.max_pitch, cp))
    const maxP = S.pitch_rate * dt
    m.pitch += Math.max(-maxP, Math.min(maxP, tp - m.pitch))
    // legs
    let [mx, my] = m.cmd.move ?? [0, 0]
    const ml = Math.hypot(mx, my)
    if (ml > 1) {
      mx /= ml
      my /= ml
    }
    const charging = m.weapons.some((x) => x && x.kind === "laser" && x.charge > 0)
    const wantBoost = !!m.cmd.boost
    let speed = S.walk_speed
    let spent = false
    if (m.grounded && wantBoost && ml > 0.1 && m.energy > 0) {
      speed = S.boost_speed
      m.energy = Math.max(0, m.energy - S.boost_drain * dt)
      spent = true
    }
    if (charging) speed *= S.charge_move_mult
    const tvx = mx * speed, tvy = my * speed
    const acc = (m.grounded ? S.ground_accel : S.air_accel) * dt
    const ex = tvx - m.vx, ey = tvy - m.vy
    const el = Math.hypot(ex, ey)
    if (el <= acc) {
      m.vx = tvx
      m.vy = tvy
    } else {
      m.vx += (ex / el) * acc
      m.vy += (ey / el) * acc
    }
    // jets
    if (!m.grounded && wantBoost && m.energy > 0) {
      m.vz = Math.min(S.max_rise_speed, m.vz + S.jet_accel * dt)
      m.energy = Math.max(0, m.energy - S.jet_drain * dt)
      spent = true
      if (this.tick % 10 === 0) this.sound("jet", m.x, m.y, m.id)
    }
    if (spent) m.lastSpend = this.t
    else if (this.t - m.lastSpend > S.energy_regen_delay) m.energy = Math.min(S.energy, m.energy + S.energy_regen * dt)
    if (!m.grounded) m.vz -= S.gravity * dt
    // horizontal move with sliding
    const R = S.radius
    const blockedAt = (x: number, y: number, z: number) => {
      if (!w.inBounds(x, y, R)) return true
      for (let k = 0; k <= 8; k++) {
        const sx = k === 8 ? x : x + Math.cos((k * Math.PI) / 4) * R * 0.95
        const sy = k === 8 ? y : y + Math.sin((k * Math.PI) / 4) * R * 0.95
        const c = w.cellOf(sx, sy)
        const z0 = z + S.step_up, z1 = z + S.height
        if (z0 >= w.cellTop[c]) continue
        for (let q = w.cellStart[c]; q < w.cellStart[c + 1]; q++) {
          const p = w.cellList[q]
          if (w.pBase[p] < z1 && w.pTop[p] > z0) return true
        }
      }
      // terrain slope at centre
      const g0 = w.ground(m.x, m.y), g1 = w.ground(x, y)
      const hd = Math.hypot(x - m.x, y - m.y)
      if (g1 > z + S.step_up && g1 - g0 > Math.tan((S.max_slope_deg * Math.PI) / 180) * Math.max(hd, 0.05)) return true
      return false
    }
    const nx = m.x + m.vx * dt, ny = m.y + m.vy * dt
    if (!blockedAt(nx, ny, m.z)) {
      m.x = nx
      m.y = ny
    } else if (!blockedAt(nx, m.y, m.z)) {
      m.x = nx
      m.vy = 0
    } else if (!blockedAt(m.x, ny, m.z)) {
      m.y = ny
      m.vx = 0
    } else {
      m.vx = 0
      m.vy = 0
    }
    // vertical
    const floor = w.floorBelow(m.x, m.y, m.z + S.step_up)
    if (m.grounded) {
      if (floor < m.z - 0.3) {
        m.grounded = false // walked off a ledge
      } else {
        m.z = floor
        m.vz = 0
      }
    }
    if (!m.grounded) {
      let nz = m.z + m.vz * dt
      if (m.vz > 0) {
        const ceil = w.ceilingAbove(m.x, m.y, m.z + S.height - 0.01)
        if (nz + S.height > ceil) {
          nz = ceil - S.height
          m.vz = 0
        }
      }
      const fl = w.floorBelow(m.x, m.y, Math.max(m.z, nz) + 0.01)
      if (nz <= fl) {
        nz = fl
        m.vz = 0
        m.grounded = true
      }
      m.z = nz
    }
    // footsteps
    const hs = Math.hypot(m.vx, m.vy)
    if (m.grounded && hs > C.sound.step_speed) {
      m.stepAcc += dt
      if (m.stepAcc >= C.sound.step_every) {
        m.stepAcc = 0
        this.sound(wantBoost && m.energy > 0 ? "boost" : "step", m.x, m.y, m.id)
      }
    }
  }

  fireWeapons(m: Mech, dt: number) {
    const C = this.cfg
    const fire = m.cmd.fire ?? [false, false]
    for (let s = 0; s < 2; s++) {
      const w = m.weapons[s]
      if (!w) continue
      const st = m.wstats[w.kind]
      w.cooldown = Math.max(0, w.cooldown - dt)
      const ready = w.cooldown <= 0 && this.t >= w.equipUntil
      const dir = [Math.cos(m.pitch) * Math.cos(m.yaw), Math.cos(m.pitch) * Math.sin(m.yaw), Math.sin(m.pitch)]
      if (w.kind === "gun") {
        if (w.reload > 0) {
          w.reload -= dt
          if (w.reload <= 0) {
            w.reload = 0
            w.ammo = st.mag
          }
          continue
        }
        if (fire[s] && ready && w.ammo > 0) {
          const sp = (st.spread_deg * Math.PI) / 180
          const yaw = m.yaw + this.rng.gauss() * sp, pitch = m.pitch + this.rng.gauss() * sp
          const d2 = [Math.cos(pitch) * Math.cos(yaw), Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch)]
          const ox = m.x, oy = m.y, oz = m.z + m.stats.muzzle_height
          const off = this.muzzleOffset(m, ox, oy, oz, dir)
          this.projs.push({ id: this.nextId++, kind: "gun", owner: m.id, x: ox + dir[0] * off, y: oy + dir[1] * off, z: oz + dir[2] * off, vx: d2[0] * st.speed, vy: d2[1] * st.speed, vz: d2[2] * st.speed, dist: 0, range: st.range, dmg: st.damage * this.dmgMult(m), ttl: 5 })
          w.cooldown = st.cooldown
          w.ammo--
          this.sound("gun", m.x, m.y, m.id)
          if (w.ammo <= 0) {
            w.reload = st.reload
            this.sound("reload", m.x, m.y, m.id)
          }
        }
      } else if (w.kind === "laser") {
        const full = st.charge
        if (this.t < m.shortUntil) {
          w.charge = 0
          w.release = false
          continue
        }
        if (w.charge > 0) {
          if (fire[s] && !w.release) {
            w.charge = Math.min(full, w.charge + dt)
            if (w.charge >= full) {
              w.fullHeld += dt
              if (w.fullHeld >= st.hold_s) this.fireLaser(m, w, st)
            }
          } else {
            // released: fire as soon as min_charge is in
            w.release = true
            if (w.charge >= st.min_charge) this.fireLaser(m, w, st)
            else w.charge += dt
          }
        } else if (fire[s] && ready) {
          w.charge = dt
          w.fullHeld = 0
          w.release = false
          this.sound("laser_charge", m.x, m.y, m.id)
        }
      } else if (w.kind === "lightning") {
        if (fire[s] && ready && m.energy >= st.energy) {
          m.energy -= st.energy
          m.lastSpend = this.t
          w.cooldown = st.cooldown
          this.fireLightning(m, st)
        }
      } else if (w.kind === "mortar") {
        if (fire[s] && ready) {
          const ox = m.x, oy = m.y, oz = m.z + m.stats.height + 0.5
          const off = this.muzzleOffset(m, ox, oy, oz, dir)
          this.projs.push({ id: this.nextId++, kind: "mortar", owner: m.id, x: ox + dir[0] * off, y: oy + dir[1] * off, z: oz + dir[2] * off, vx: dir[0] * st.speed, vy: dir[1] * st.speed, vz: dir[2] * st.speed, dist: 0, range: 1e9, dmg: st.damage * this.dmgMult(m), ttl: st.ttl })
          w.cooldown = st.cooldown
          this.sound("mortar", m.x, m.y, m.id)
        }
      }
    }
  }

  muzzleOffset(m: Mech, ox: number, oy: number, oz: number, dir: number[]) {
    const off = m.stats.radius + 0.5
    const f = this.world.raycast(ox, oy, oz, ox + dir[0] * off, oy + dir[1] * off, oz + dir[2] * off)
    return Math.max(0, off * f - 0.05)
  }

  fireLaser(m: Mech, w: WeaponState, st: Record<string, number>) {
    const frac = st.min_frac + (1 - st.min_frac) * Math.min(1, w.charge / st.charge)
    w.charge = 0
    w.fullHeld = 0
    w.release = false
    w.cooldown = st.cooldown
    const dir = [Math.cos(m.pitch) * Math.cos(m.yaw), Math.cos(m.pitch) * Math.sin(m.yaw), Math.sin(m.pitch)]
    const ox = m.x, oy = m.y, oz = m.z + m.stats.muzzle_height
    const off = this.muzzleOffset(m, ox, oy, oz, dir)
    const sx = ox + dir[0] * off, sy = oy + dir[1] * off, sz = oz + dir[2] * off
    const L = st.range
    const fw = this.world.raycast(sx, sy, sz, sx + dir[0] * L, sy + dir[1] * L, sz + dir[2] * L)
    let len = L * fw
    let pierce = st.pierce ?? 0
    let skip = m.id
    let from = 0
    const hitSet = new Set<any>()
    for (;;) {
      const h = this.rayEntities(sx + dir[0] * from, sy + dir[1] * from, sz + dir[2] * from, dir[0], dir[1], dir[2], len - from, skip)
      if (!h || hitSet.has(h.ent)) break
      hitSet.add(h.ent)
      let dmg = st.damage * frac * this.dmgMult(m)
      let effect: string | undefined
      if ("bot" in h.ent && (h.ent as Mech).weapons.some((x) => x && x.kind === "mortar")) {
        dmg *= 1 + st.cookoff
        effect = "cookoff"
        ;(h.ent as Mech).events.push({ type: "effect", effect: "cookoff", by: m.id })
      }
      this.damage(h.ent, dmg, "laser", m, m.x, m.y, effect)
      if (pierce-- <= 0) {
        len = from + h.t
        break
      }
      from = from + h.t + 0.5
      skip = h.ent.id
    }
    this.beams.push({ t: this.t, by: m.id, kind: "laser", path: [[sx, sy, sz], [sx + dir[0] * len, sy + dir[1] * len, sz + dir[2] * len]] })
    this.sound("laser", m.x, m.y, m.id)
  }

  fireLightning(m: Mech, st: Record<string, number>) {
    const ox = m.x, oy = m.y, oz = m.z + m.stats.muzzle_height
    const cone = (st.cone_deg * Math.PI) / 180
    const cands: { ent: any; x: number; y: number; z: number; d: number }[] = []
    const consider = (ent: any, x: number, y: number, z: number) => {
      const d = Math.hypot(x - ox, y - oy)
      cands.push({ ent, x, y, z, d })
    }
    for (const o of this.mechs) if (o.alive && o !== m) consider(o, o.x, o.y, o.z + o.stats.height / 2)
    for (const n of this.npcs) if (n.hp > 0) consider(n, n.x, n.y, n.z + this.cfg.npc.height / 2)
    for (const c of this.crates) if ((c.hp ?? 0) > 0) consider(c, c.x, c.y, c.z + 1.2)
    let first: (typeof cands)[0] | null = null
    for (const c of cands) {
      if (c.d > st.range) continue
      if (Math.abs(angDiff(Math.atan2(c.y - oy, c.x - ox), m.yaw)) > cone / 2) continue
      if (!this.world.clear(ox, oy, oz, c.x, c.y, c.z)) continue
      if (!first || c.d < first.d) first = c
    }
    const path: number[][] = [[ox, oy, oz]]
    this.sound("lightning", m.x, m.y, m.id)
    if (!first) {
      const dir = [Math.cos(m.yaw), Math.sin(m.yaw), 0]
      const f = this.world.raycast(ox, oy, oz, ox + dir[0] * st.range, oy + dir[1] * st.range, oz)
      path.push([ox + dir[0] * st.range * f, oy + dir[1] * st.range * f, oz])
      this.beams.push({ t: this.t, by: m.id, kind: "lightning", path })
      return
    }
    let dmg = st.damage * this.dmgMult(m)
    const hit = new Set<any>()
    let cur = first
    for (let j = 0; j <= st.chain; j++) {
      hit.add(cur.ent)
      path.push([cur.x, cur.y, cur.z])
      let effect: string | undefined
      if ("bot" in cur.ent && (cur.ent as Mech).weapons.some((x) => x && x.kind === "laser")) {
        effect = "short"
        const v = cur.ent as Mech
        v.shortUntil = this.t + st.short_s
        for (const w of v.weapons) if (w && w.kind === "laser") w.charge = 0
        v.events.push({ type: "effect", effect: "short", by: m.id })
      }
      this.damage(cur.ent, dmg, "lightning", m, j === 0 ? m.x : path[path.length - 2][0], j === 0 ? m.y : path[path.length - 2][1], effect)
      dmg *= st.chain_falloff
      let next: (typeof cands)[0] | null = null
      let nd = Infinity
      for (const c of cands) {
        if (hit.has(c.ent)) continue
        const d = Math.hypot(c.x - cur.x, c.y - cur.y, c.z - cur.z)
        if (d > st.chain_range || d >= nd) continue
        if (!this.world.clear(cur.x, cur.y, cur.z, c.x, c.y, c.z)) continue
        nd = d
        next = c
      }
      if (!next) break
      cur = next
    }
    this.beams.push({ t: this.t, by: m.id, kind: "lightning", path })
  }

  explode(p: Proj, x: number, y: number, z: number, direct: any) {
    const C = this.cfg
    const owner = this.mechs[p.owner] ?? null
    const st = owner ? owner.wstats.mortar : C.weapons.mortar
    const mult = owner ? this.dmgMult(owner) : 1
    this.sound("explosion", x, y, -1)
    if (direct) this.damage(direct, st.damage * mult, "mortar", owner, x, y)
    const R = st.splash_radius
    for (const m of this.mechs) {
      if (!m.alive) continue
      const cz = m.z + m.stats.height / 2
      const d = Math.max(0, Math.hypot(m.x - x, m.y - y, cz - z) - m.stats.radius)
      if (d > R) continue
      if (!this.world.clear(x, y, z + 0.3, m.x, m.y, cz)) continue
      const fall = 1 - (1 - st.splash_edge) * (d / R)
      let dmg = st.splash * mult * fall
      if (m === owner) dmg *= m.stats.self_damage_mult
      if (m !== direct) this.damage(m, dmg, "mortar", owner, x, y, m === owner ? undefined : "concuss")
      // concussion
      const [ux, uy] = (() => {
        const l = Math.hypot(m.x - x, m.y - y)
        return l > 0.01 ? [(m.x - x) / l, (m.y - y) / l] : [1, 0]
      })()
      m.vx += ux * st.knock * fall
      m.vy += uy * st.knock * fall
      m.vz = Math.max(m.vz, st.knock_up * fall)
      m.grounded = false
      m.energy = Math.max(0, m.energy - st.drain * fall)
      if (m !== owner) m.events.push({ type: "effect", effect: "concuss", by: p.owner })
    }
    for (const n of this.npcs) {
      if (n.hp <= 0 || n === direct) continue
      const d = Math.hypot(n.x - x, n.y - y, n.z + 1.75 - z)
      if (d < R) this.damage(n, st.splash * mult * (1 - (1 - st.splash_edge) * (d / R)), "mortar", owner, x, y)
    }
    for (const c of this.crates) {
      if ((c.hp ?? 0) <= 0 || c === direct) continue
      const d = Math.hypot(c.x - x, c.y - y, c.z + 1.2 - z)
      if (d < R) this.damage(c, st.splash * mult * (1 - (1 - st.splash_edge) * (d / R)), "mortar", owner, x, y)
    }
  }

  stepProjectiles(dt: number) {
    const g = this.cfg.weapons.mortar.gravity
    const keep: Proj[] = []
    for (const p of this.projs) {
      const ox = p.x, oy = p.y, oz = p.z
      let nvz = p.vz
      if (p.kind === "mortar") nvz -= g * dt
      const nx = p.x + p.vx * dt, ny = p.y + p.vy * dt, nz = p.z + (p.vz + nvz) * 0.5 * dt
      const seg = Math.hypot(nx - ox, ny - oy, nz - oz)
      let segLen = seg
      if (p.kind !== "mortar" && p.dist + seg > p.range) segLen = p.range - p.dist
      const fw = this.world.raycast(ox, oy, oz, ox + ((nx - ox) * segLen) / seg, oy + ((ny - oy) * segLen) / seg, oz + ((nz - oz) * segLen) / seg)
      const dx = (nx - ox) / seg, dy = (ny - oy) / seg, dz = (nz - oz) / seg
      const he = this.rayEntities(ox, oy, oz, dx, dy, dz, segLen * fw, p.kind === "npc" ? -1 : p.owner, p.kind === "gun" ? this.cfg.projectile.gun_radius : p.kind === "npc" ? this.cfg.projectile.npc_radius : 0)
      if (he && !(p.kind === "npc" && he.ent.id === p.owner)) {
        const hx = ox + dx * he.t, hy = oy + dy * he.t, hz = oz + dz * he.t
        if (p.kind === "mortar") this.explode(p, hx, hy, hz, he.ent)
        else {
          if (p.kind === "npc") {
            if ("bot" in he.ent) this.damage(he.ent, p.dmg, "npc", this.npcs.find((n) => n.id === p.owner) ?? null, ox, oy)
          } else this.damage(he.ent, p.dmg, "gun", this.mechs[p.owner], ox, oy)
        }
        continue
      }
      if (fw < 1) {
        if (p.kind === "mortar") this.explode(p, ox + (nx - ox) * fw * (segLen / seg), oy + (ny - oy) * fw * (segLen / seg), oz + (nz - oz) * fw * (segLen / seg), null)
        continue
      }
      p.dist += seg
      p.ttl -= dt
      if (p.kind !== "mortar" && p.dist >= p.range) continue
      if (p.ttl <= 0) {
        if (p.kind === "mortar") this.explode(p, nx, ny, nz, null)
        continue
      }
      p.x = nx
      p.y = ny
      p.z = nz
      p.vz = nvz
      keep.push(p)
    }
    this.projs = keep
  }

  stepNpcs(dt: number) {
    const C = this.cfg.npc
    for (const n of this.npcs) {
      if (n.hp <= 0) continue
      n.cooldown -= dt
      const homeD = Math.hypot(n.x - n.hx, n.y - n.hy)
      // targeting
      let tgt: Mech | null = n.target !== null ? this.mechs[n.target] : null
      if (tgt && (!tgt.alive || Math.hypot(tgt.x - n.x, tgt.y - n.y) > C.deaggro_range || homeD > C.chase_leash)) {
        tgt = null
        n.target = null
        n.aggroBy = null
      }
      if (n.aggroBy !== null && this.mechs[n.aggroBy]?.alive) {
        tgt = this.mechs[n.aggroBy]
        n.target = tgt.id
      }
      if (!tgt && homeD <= C.leash) {
        let bd = C.aggro_range
        for (const m of this.mechs) {
          if (!m.alive) continue
          const d = Math.hypot(m.x - n.x, m.y - n.y)
          if (d < bd && this.world.clear(n.x, n.y, n.z + 3, m.x, m.y, m.z + 4.5)) {
            bd = d
            tgt = m
          }
        }
        if (tgt) n.target = tgt.id
      }
      let gx = n.gx, gy = n.gy
      if (tgt) {
        const d = Math.hypot(tgt.x - n.x, tgt.y - n.y)
        n.yaw = Math.atan2(tgt.y - n.y, tgt.x - n.x)
        if (d > 30) {
          gx = tgt.x
          gy = tgt.y
        } else {
          gx = n.x
          gy = n.y
        }
        const cz = tgt.z + tgt.stats.height / 2
        if (n.cooldown <= 0 && d < C.deaggro_range && this.world.clear(n.x, n.y, n.z + 3, tgt.x, tgt.y, cz)) {
          n.cooldown = C.cooldown
          const tt = d / C.projectile_speed
          const px = tgt.x + tgt.vx * tt * 0.5, py = tgt.y + tgt.vy * tt * 0.5
          const sp = (C.spread_deg * Math.PI) / 180
          const yaw = Math.atan2(py - n.y, px - n.x) + this.rng.gauss() * sp
          const pitch = Math.atan2(cz - (n.z + 3), Math.hypot(px - n.x, py - n.y)) + this.rng.gauss() * sp
          this.projs.push({ id: this.nextId++, kind: "npc", owner: n.id, x: n.x + Math.cos(yaw) * 2.3, y: n.y + Math.sin(yaw) * 2.3, z: n.z + 3, vx: Math.cos(pitch) * Math.cos(yaw) * C.projectile_speed, vy: Math.cos(pitch) * Math.sin(yaw) * C.projectile_speed, vz: Math.sin(pitch) * C.projectile_speed, dist: 0, range: 200, dmg: C.damage, ttl: 4 })
          this.sound("npc_gun", n.x, n.y, -1)
        }
      } else {
        if (homeD > C.leash || Math.hypot(n.gx - n.x, n.gy - n.y) < 2 || this.rng.next() < 0.002) {
          const a = this.rng.next() * Math.PI * 2, r = this.rng.next() * C.leash * 0.8
          n.gx = n.hx + Math.cos(a) * r
          n.gy = n.hy + Math.sin(a) * r
        }
        gx = n.gx
        gy = n.gy
      }
      const dx = gx - n.x, dy = gy - n.y, dl = Math.hypot(dx, dy)
      if (dl > 0.5) {
        const nx = n.x + (dx / dl) * C.speed * dt, ny = n.y + (dy / dl) * C.speed * dt
        const nz = this.world.surface(nx, ny)
        if (Math.abs(nz - n.z) < 1.5 && !this.world.columnBlocked(nx, ny, nz + 1.3, nz + C.height)) {
          n.vx = (dx / dl) * C.speed
          n.vy = (dy / dl) * C.speed
          n.x = nx
          n.y = ny
          n.z = nz
        } else {
          n.gx = n.hx
          n.gy = n.hy
          n.vx = n.vy = 0
        }
      } else n.vx = n.vy = 0
    }
  }

  stepZone(dt: number) {
    const Z = this.cfg.zone
    const z = this.zone
    if (this.t >= z.shrink_end && this.phase < Z.phases.length) {
      // advance phase
      this.phase++
      const prevR = z.next_radius
      z.center = [...z.next_center]
      z.radius = prevR
      if (this.phase < Z.phases.length) {
        const ph = Z.phases[this.phase]
        z.next_center = this.randomInside(z.center[0], z.center[1], Math.max(0, prevR - ph.radius))
        z.next_radius = ph.radius
        z.shrink_start = this.t + ph.hold_s
        z.shrink_end = this.t + ph.hold_s + ph.shrink_s
        z.dps = ph.dps
      } else {
        z.next_center = [...z.center]
        z.next_radius = z.radius
        z.shrink_start = 1e9
        z.shrink_end = 1e9
      }
    }
    const c = zoneAt(z, this.t)
    for (const m of this.mechs) {
      if (!m.alive) continue
      if (Math.hypot(m.x - c.x, m.y - c.y) > c.r) this.damage(m, z.dps * dt, "zone", null, m.x, m.y)
    }
  }

  stepDrops(dt: number) {
    const D = this.cfg.drops
    if (!D) return
    for (const time of D.times) {
      if (this.t >= time && this.t - dt < time) {
        const p = this.openGround(this.zone.next_center[0], this.zone.next_center[1], this.zone.next_radius * D.spread)
        if (p) this.drops.push({ id: 20000 + this.drops.length, x: p[0], y: p[1], z: p[2], landT: this.t + D.fall_s, holder: null, progress: 0, taken: false })
      }
    }
    for (const d of this.drops) {
      if (d.taken || this.t < d.landT) continue
      if (this.t - dt < d.landT) this.sound("drop", d.x, d.y, -1)
      const inside = this.mechs.filter((m) => m.alive && Math.hypot(m.x - d.x, m.y - d.y) < D.radius && Math.abs(m.z - d.z) < 6)
      if (inside.length === 1) {
        if (d.holder !== inside[0].id) {
          d.holder = inside[0].id
          d.progress = 0
        }
        d.progress += dt
        if (d.progress >= D.capture_s) {
          const m = inside[0]
          d.taken = true
          this.addCubes(m, D.cubes)
          m.hp = m.stats.hp
          m.energy = m.stats.energy
          m.events.push({ type: "drop", id: d.id, cubes: m.cubes })
        }
      } else if (inside.length === 0) {
        d.holder = null
        d.progress = 0
      }
    }
  }

  stepCubes() {
    const R = this.cfg.cubes.pickup_radius
    const keep: Item[] = []
    for (const c of this.cubes) {
      let best: Mech | null = null, bd = R
      for (const m of this.mechs) {
        if (!m.alive) continue
        const d = Math.hypot(m.x - c.x, m.y - c.y)
        if (d <= bd && Math.abs(m.z - c.z) < 4) {
          if (d < bd || (best && m.id < best.id)) best = m
          bd = d
        }
      }
      if (best) {
        this.addCubes(best, 1)
        best.events.push({ type: "pickup", cubes: best.cubes })
      } else keep.push(c)
    }
    this.cubes = keep
  }

  stepRegen(dt: number) {
    const c = zoneAt(this.zone, this.t)
    for (const m of this.mechs) {
      if (!m.alive) continue
      const inZone = Math.hypot(m.x - c.x, m.y - c.y) <= c.r
      if (inZone && this.t - Math.max(m.lastHurt, m.lastDeal) > m.stats.regen_delay) m.hp = Math.min(m.stats.hp, m.hp + m.stats.regen_per_s * dt)
    }
  }

  pushApart() {
    const ms = this.mechs.filter((m) => m.alive)
    for (let i = 0; i < ms.length; i++)
      for (let j = i + 1; j < ms.length; j++) {
        const a = ms[i], b = ms[j]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        const R = a.stats.radius + b.stats.radius
        if (d < R && d > 1e-6 && Math.abs(a.z - b.z) < 8) {
          const push = (R - d) / 2
          const ux = (a.x - b.x) / d, uy = (a.y - b.y) / d
          a.x += ux * push
          a.y += uy * push
          b.x -= ux * push
          b.y -= uy * push
        }
      }
  }

  step() {
    const C = this.cfg
    const dt = 1 / C.match.tick_hz
    if (this.tick % C.match.decide_every === 0) this.decide()
    this.deadThisTick = []
    for (const m of this.mechs) if (m.alive) this.physics(m, dt)
    this.pushApart()
    for (const m of this.mechs) if (m.alive) this.fireWeapons(m, dt)
    this.stepProjectiles(dt)
    this.stepNpcs(dt)
    this.stepZone(dt)
    this.stepDrops(dt)
    this.stepCubes()
    this.stepRegen(dt)
    // offers expire
    for (const m of this.mechs) {
      if (m.alive && m.offers.length && this.t >= m.offers[0].expires) {
        const o = m.offers.shift()!
        this.applyUpgrade(m, o.choices[0])
      }
    }
    // placements
    if (this.deadThisTick.length) {
      const aliveAfter = this.mechs.filter((m) => m.alive).length
      const place = aliveAfter + 1
      for (const m of this.deadThisTick) m.place = place
      if (this.verbose) for (const m of this.deadThisTick) this.log.push(`t=${this.t.toFixed(1)} ${m.name}#${m.id} died (${m.deathCause}) place ${place}`)
    }
    // prune sounds/beams
    this.sounds = this.sounds.filter((s) => this.t - s.t < 1)
    this.beams = this.beams.filter((b) => this.t - b.t < 0.5)
    this.tick++
    this.t = this.tick * dt
  }

  run(): SimResult {
    const C = this.cfg
    while (this.t < C.match.duration_s) {
      this.step()
      const alive = this.mechs.filter((m) => m.alive)
      if (alive.length <= 1) break
    }
    // survivors ranked by hp
    const alive = this.mechs.filter((m) => m.alive).sort((a, b) => b.hp - a.hp)
    alive.forEach((m, i) => (m.place = i + 1))
    return {
      duration: this.t,
      mechs: this.mechs,
      places: this.mechs.map((m) => ({ id: m.id, name: m.name, place: m.place, kills: m.kills, cubes: m.cubes, dmgTaken: Math.round(m.dmgTaken), dmgDealt: Math.round(m.dmgDealt), zoneDmg: Math.round(m.zoneDmg), cause: m.deathCause, maxMs: m.maxMs, late: m.late, modes: m.modes })),
    }
  }
}
