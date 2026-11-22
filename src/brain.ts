/**
 * The decision maker. One instance per match; act() is called once per observation and must return quickly
 * (well under the 50 ms budget on one CPU).
 *
 * Priorities: stay inside the zone, don't die, then gather what makes us harder to kill (a laser, cubes,
 * upgrades, supply drops), and fight only when the odds are good or we're already engaged.
 */
import type { Action, ActorObs, Hello, Observation, WeaponObs } from "./mechfight.ts"
import { draw } from "./mechfight.ts"
import { Nav } from "./nav.ts"
import { angDiff, clamp, norm2, Rng, wrap, zoneAt, type V2, type V3 } from "./util.ts"
import { loadWorld, type World } from "./world.ts"

type Track = {
  id: number
  kind: "mech" | "npc"
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  yaw: number
  pitch: number
  hp: number
  maxHp: number
  cubes: number
  weapons: string[]
  charging: boolean
  firstSeen: number
  lastSeen: number
  listed: boolean
  attackedMeT: number
  hitByMeT: number
  homeX: number
  homeY: number
}

type Item = { id: number; kind: string; x: number; y: number; z: number; t: number; hp: number }

type Mode = "zone" | "retreat" | "fight" | "hunt" | "loot" | "drop" | "position" | "evade"
type Plan = { mode: Mode; dest: V2 | null; target: Track | null; urgent: boolean; face: number | null; why?: string }

const LOSING_RATIO = Number((typeof process !== "undefined" && process.env?.MECH_LOSING) || 0.65)
const PROFILE = typeof process !== "undefined" && !!process.env?.MECH_PROFILE
const WEAPON_RANK: Record<string, number> = { laser: 3, lightning: 2, mortar: 1, gun: 0 }

const UPGRADE_PRIORITY = [
  "plating",
  "armor",
  "laser_damage",
  "nanites",
  "gun_damage",
  "laser_charge",
  "gun_rate",
  "lightning_efficiency",
  "servos",
  "sensors",
  "capacitor",
  "reactor",
  "gyros",
  "jets",
  "gun_velocity",
  "gun_mag",
  "lightning_range",
  "lightning_chain",
  "mortar_reload",
  "mortar_velocity",
  "mortar_splash",
  "laser_pierce",
]

export type BrainOpts = { name?: string; aggression?: number; debug?: boolean; world?: World | null; nav?: Nav | null; lurk?: number }

export class Brain {
  name: string
  cfg: any
  world: World | null
  nav: Nav | null
  rng: Rng
  slot: number
  aggression: number
  debugOn: boolean
  /** until this match time, stay hidden near spawn and only grab loot close by */
  lurkUntil: number
  hideSpot: V3 | null = null

  // memory
  tracks = new Map<number, Track>()
  pickups = new Map<number, Item>()
  crates = new Map<number, Item>()
  cubes = new Map<number, Item>()
  ignorePickup = new Map<number, number>()
  /** destinations A* couldn't reach: key -> until */
  unreachable = new Map<string, number>()
  sounds: { t: number; kind: string; bearing: number; dist: string }[] = []
  damageLog: { t: number; amount: number; by: number | null; bearing: number | null; weapon: string; rear: boolean }[] = []
  lastDamageT = -99
  lastDealT = -99
  shortUntil = -99
  kills = 0

  // per-tick
  t = 0
  obs!: Observation
  me!: Observation["self"]
  px = 0
  py = 0
  pz = 0
  eyeH = 8
  muzH = 7
  radius = 2.5
  height = 9
  mode: Mode = "position"
  modeWhy = ""

  // nav state
  path: V3[] | null = null
  pathGoal: V2 | null = null
  pathT = -99
  pathIdx = 0
  stuckSince = -1
  unstickUntil = -1
  unstickDir: V2 = [1, 0]
  lastProgressPos: V2 = [0, 0]
  lastProgressT = 0
  climbing = false
  climbStart = -1
  pathNoClimb = false
  climbNeedAhead = 0
  avoidSpots: { x: number; y: number; r: number; cost: number; until: number }[] = []
  climbTarget = 0

  // combat state
  targetId: number | null = null
  strafeSign = 1
  strafeUntil = 0
  strafeSpeed = 1
  campSpot: V3 | null = null
  campKey = ""
  scanPhase = 0
  lastFireT = -99
  laserHolding = false
  mortarAimUntil = -1
  retreatSpot: V3 | null = null
  retreatSpotT = -99
  lookYaw = 0
  prevAlive = 16
  lock: { mode: Mode; until: number; dest: V2 | null } | null = null
  tickStart = 0
  /** ms spent in this decision so far */
  elapsed() {
    return performance.now() - this.tickStart
  }

  constructor(hello: Hello, opts: BrainOpts = {}) {
    this.cfg = hello.config
    this.slot = hello.slot
    this.rng = new Rng((hello.seed ?? 1) ^ 0x9e3779b9)
    this.name = opts.name ?? "TheBestMech"
    this.aggression = opts.aggression ?? 1
    this.debugOn = opts.debug ?? true
    this.lurkUntil = opts.lurk ?? 25
    if (opts.world !== undefined) {
      this.world = opts.world
      this.nav = opts.nav ?? (opts.world ? new Nav(opts.world) : null)
    } else {
      const m = this.cfg.mech
      this.world = loadWorld(hello.map.dir, m.height ?? 9, m.step_up ?? 1.2)
      this.nav = this.world ? new Nav(this.world) : null
    }
  }

  // ------------------------------------------------------------------ helpers
  los(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    return this.world ? this.world.clear(ax, ay, az, bx, by, bz) : true
  }
  surface(x: number, y: number): number {
    return this.world ? this.world.surface(x, y) : this.pz
  }
  scaleOf(cubes: number) {
    return 1 + (this.cfg.cubes.size_per_cube ?? 0.05) * cubes
  }
  dist(x: number, y: number) {
    return Math.hypot(x - this.px, y - this.py)
  }
  weapon(kind: string): { slot: number; w: WeaponObs } | null {
    const ws = this.me.weapons
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i]
      if (w && w.kind === kind) return { slot: i, w }
    }
    return null
  }
  zoneNow() {
    return zoneAt(this.obs.zone, this.t)
  }
  inZoneAt(x: number, y: number, tau: number, margin = 0) {
    const z = zoneAt(this.obs.zone, tau)
    return Math.hypot(x - z.x, y - z.y) < z.r - margin
  }
  center(tr: Track): V3 {
    return [tr.x, tr.y, tr.z + (tr.kind === "npc" ? (this.cfg.npc.height ?? 3.5) / 2 : 4.5 * this.scaleOf(tr.cubes))]
  }

  /** can enemy track `e` see a point (our body) right now? */
  seesPoint(e: Track, x: number, y: number, z: number, h: number): boolean {
    const d = Math.hypot(x - e.x, y - e.y)
    const v = this.cfg.vision
    const eye = e.z + (e.kind === "npc" ? 3 : 8 * this.scaleOf(e.cubes))
    if (d > v.range + 25) return false
    if (e.kind === "npc") {
      if (d > (this.cfg.npc.aggro_range ?? 45)) return false
    } else if (d > v.near_range) {
      const b = Math.atan2(y - e.y, x - e.x)
      if (Math.abs(angDiff(b, e.yaw)) > ((v.fov_deg / 2 + 8) * Math.PI) / 180) return false
    }
    return this.los(e.x, e.y, eye, x, y, z + h * 0.5) || this.los(e.x, e.y, eye, x, y, z + h * 0.95)
  }

  ukey(x: number, y: number) {
    return `${Math.round(x / 6)},${Math.round(y / 6)}`
  }
  reachable(x: number, y: number) {
    const u = this.unreachable.get(this.ukey(x, y))
    return u === undefined || u < this.t
  }

  // ------------------------------------------------------------------ main
  act(obs: Observation): Omit<Action, "tick"> {
    const t0 = performance.now()
    this.tickStart = t0
    this.obs = obs
    this.t = obs.t
    this.me = obs.self
    const me = obs.self
    ;[this.px, this.py, this.pz] = me.pos
    const st = me.stats ?? {}
    this.eyeH = st.eye_height ?? 8
    this.muzH = st.muzzle_height ?? 7
    this.radius = st.radius ?? 2.5
    this.height = st.height ?? 9
    this.update(obs)

    const act: Omit<Action, "tick"> = {}
    if (obs.offer) act.pick = this.pickUpgrade(obs.offer)

    // ---- choose what to do
    const ta = performance.now()
    const plan = this.decide()
    this.mode = plan.mode

    // ---- movement
    const tb = performance.now()
    const mv = this.movement(plan)
    // ---- aim and fire
    const tc = performance.now()
    const af = this.aimAndFire(plan)
    const td = performance.now()
    if (PROFILE && td - t0 > 8) console.error(`slow tick t=${this.t} mode=${plan.mode}/${this.modeWhy} total=${(td - t0).toFixed(1)} update=${(ta - t0).toFixed(1)} decide=${(tb - ta).toFixed(1)} move=${(tc - tb).toFixed(1)} fire=${(td - tc).toFixed(1)} expanded=${this.nav?.lastExpanded}`)

    // never send NaN/Infinity (it would serialize as null and make the action invalid)
    const fin = (v: number, d: number) => (Number.isFinite(v) ? v : d)
    const ml = Math.hypot(fin(mv.move[0], 0), fin(mv.move[1], 0))
    act.move = ml > 1 ? [fin(mv.move[0], 0) / ml, fin(mv.move[1], 0) / ml] : [fin(mv.move[0], 0), fin(mv.move[1], 0)]
    act.boost = !!mv.boost
    act.jump = !!mv.jump
    act.aim = [fin(af.aim[0], me.aim[0]), fin(af.aim[1], 0)]
    act.fire = [!!af.fire[0], !!af.fire[1]]
    if (af.reload) act.reload = true
    const loot = this.lootAction()
    if (loot) {
      act.take = loot.take
      if (loot.drop !== undefined) act.drop = loot.drop
    }
    if (this.debugOn) {
      const ms = performance.now() - t0
      draw.label(`${this.mode}${this.modeWhy ? ":" + this.modeWhy : ""} hp${Math.round(me.hp)} ${ms.toFixed(0)}ms`)
      if (plan.dest) draw.point([plan.dest[0], plan.dest[1], this.surface(plan.dest[0], plan.dest[1]) + 1], "#40c0ff", 5)
      if (this.targetId !== null) {
        const tr = this.tracks.get(this.targetId)
        if (tr) draw.line([this.px, this.py, this.pz + this.muzH], this.center(tr), "#ff5040")
      }
    }
    return act
  }

  // ------------------------------------------------------------------ memory update
  update(obs: Observation) {
    const t = this.t
    const me = obs.self
    for (const e of obs.events) {
      switch (e.type) {
        case "damaged": {
          this.damageLog.push({ t, amount: e.amount, by: e.by, bearing: e.bearing, weapon: e.weapon, rear: !!e.rear })
          if (e.weapon !== "zone") this.lastDamageT = t
          if (e.by !== null && e.by !== undefined) {
            const tr = this.tracks.get(e.by)
            if (tr) tr.attackedMeT = t
          }
          break
        }
        case "hit":
          if (e.target < 1000) this.lastDealT = t
          {
            const tr = this.tracks.get(e.target)
            if (tr) tr.hitByMeT = t
          }
          break
        case "kill":
          this.kills++
          this.tracks.delete(e.target)
          break
        case "effect":
          if (e.effect === "short") this.shortUntil = t + (this.cfg.weapons.laser ? this.cfg.weapons.lightning.short_s ?? 2 : 2)
          break
        case "took":
          this.pickups.delete(e.id)
          break
        case "dropped":
          this.ignorePickup.set(e.id, t + 1e6)
          this.pickups.set(e.id, { id: e.id, kind: e.kind, x: this.px, y: this.py, z: this.pz, t, hp: 0 })
          break
        case "take_failed":
          this.ignorePickup.set(e.id, t + (e.reason === "range" ? 1 : 30))
          if (e.reason === "gone") this.pickups.delete(e.id)
          break
        case "pickup":
          break
      }
    }
    while (this.damageLog.length && this.damageLog[0].t < t - 15) this.damageLog.shift()

    // tracks
    for (const tr of this.tracks.values()) tr.listed = false
    for (const m of obs.mechs) {
      if (m.id === me.id) continue
      let tr = this.tracks.get(m.id)
      if (!tr) {
        tr = {
          id: m.id,
          kind: m.kind,
          x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0,
          hp: 1400, maxHp: 1400, cubes: 0, weapons: [], charging: false,
          firstSeen: t, lastSeen: t, listed: true, attackedMeT: -99, hitByMeT: -99,
          homeX: m.pos[0], homeY: m.pos[1],
        }
        this.tracks.set(m.id, tr)
      }
      this.applyActor(tr, m)
      tr.lastSeen = t
      tr.listed = true
    }
    for (const [id, tr] of this.tracks) {
      if (!tr.listed) {
        // dead reckon a little, then forget
        if (t - tr.lastSeen > (tr.kind === "npc" ? 60 : 25)) this.tracks.delete(id)
      }
    }
    if (obs.alive < this.prevAlive) {
      // somebody died: drop stale (unlisted) mech tracks with low hp (likely the dead one)
      for (const [id, tr] of this.tracks) if (tr.kind === "mech" && !tr.listed && tr.hp < 400) this.tracks.delete(id)
    }
    this.prevAlive = obs.alive

    // items
    const seenP = new Set<number>(), seenC = new Set<number>(), seenK = new Set<number>()
    for (const p of obs.pickups) {
      seenP.add(p.id)
      this.pickups.set(p.id, { id: p.id, kind: p.kind, x: p.pos[0], y: p.pos[1], z: p.pos[2], t, hp: 0 })
    }
    for (const c of obs.crates) {
      seenC.add(c.id)
      this.crates.set(c.id, { id: c.id, kind: "crate", x: c.pos[0], y: c.pos[1], z: c.pos[2], t, hp: c.hp ?? 300 })
    }
    for (const c of obs.cubes) {
      seenK.add(c.id)
      this.cubes.set(c.id, { id: c.id, kind: "cube", x: c.pos[0], y: c.pos[1], z: c.pos[2], t, hp: 0 })
    }
    const ex = this.px, ey = this.py, ez = this.pz + this.eyeH
    const prune = (m: Map<number, Item>, seen: Set<number>, maxAge: number) => {
      for (const [id, it] of m) {
        if (seen.has(id)) continue
        const d = Math.hypot(it.x - ex, it.y - ey)
        if (t - it.t > maxAge) m.delete(id)
        else if (d < 35 && this.los(ex, ey, ez, it.x, it.y, it.z + 1)) m.delete(id)
      }
    }
    prune(this.pickups, seenP, 240)
    prune(this.crates, seenC, 240)
    prune(this.cubes, seenK, 120)
    for (const [id, until] of this.ignorePickup) if (until < t) this.ignorePickup.delete(id)
    for (const [k, until] of this.unreachable) if (until < t) this.unreachable.delete(k)

    for (const s of obs.sounds) this.sounds.push({ t: t - s.age, kind: s.kind, bearing: s.bearing, dist: s.dist })
    while (this.sounds.length && this.sounds[0].t < t - 8) this.sounds.shift()
  }

  applyActor(tr: Track, m: ActorObs) {
    tr.kind = m.kind
    ;[tr.x, tr.y, tr.z] = m.pos
    ;[tr.vx, tr.vy, tr.vz] = m.vel
    tr.yaw = m.aim[0]
    tr.pitch = m.aim[1]
    if (m.hp !== undefined) tr.hp = m.hp
    if (m.max_hp !== undefined) tr.maxHp = m.max_hp
    if (m.cubes !== undefined) tr.cubes = m.cubes
    if (m.weapons) tr.weapons = m.weapons
    tr.charging = !!m.charging
  }

  // ------------------------------------------------------------------ evaluation
  /** rough damage per second a loadout deals at range d */
  loadoutDps(weapons: string[], d: number, cubes: number, energy = 100): number {
    const W = this.cfg.weapons
    let dps = 0
    for (const k of weapons) {
      if (k === "gun") {
        const g = W.gun
        if (d < g.range) dps += (g.damage / g.cooldown) * (g.mag * g.cooldown) / (g.mag * g.cooldown + g.reload) * clamp(1.1 - d / 250, 0.25, 0.9)
      } else if (k === "laser") {
        const l = W.laser
        if (d < l.range) dps += (l.damage / (l.charge + l.cooldown)) * 0.85
      } else if (k === "lightning") {
        const l = W.lightning
        if (d < l.range && energy > 10) dps += (l.damage / l.cooldown) * 0.9
      } else if (k === "mortar") {
        const m = W.mortar
        if (d > 15 && d < 230) dps += ((m.damage * 0.25 + m.splash * 0.4) / m.cooldown)
      }
    }
    return dps * (1 + (this.cfg.cubes.damage_per_cube ?? 0.04) * Math.min(cubes, this.cfg.cubes.stat_cap ?? 10))
  }

  myWeapons(): string[] {
    return this.me.weapons.filter((w): w is WeaponObs => !!w).map((w) => w.kind)
  }

  /** enemies that matter now: seen recently */
  threats(maxAge = 6): Track[] {
    const out: Track[] = []
    for (const tr of this.tracks.values()) {
      if (tr.kind !== "mech") continue
      if (this.t - tr.lastSeen > maxAge) continue
      out.push(tr)
    }
    return out
  }

  shootable(tr: Track): boolean {
    const [cx, cy, cz] = this.center(tr)
    const mz = this.pz + this.muzH
    return this.los(this.px, this.py, mz, cx, cy, cz) || this.los(this.px, this.py, mz, cx, cy, cz + 2)
  }

  // ------------------------------------------------------------------ decision
  decide(): Plan {
    const p = this.decideRaw()
    const t = this.t
    const lk = this.lock
    // hysteresis: don't flip out of retreat/fight immediately (it thrashes between cover and exposure)
    if (lk && t < lk.until && p.mode !== "zone") {
      if (lk.mode === "retreat" && (p.mode === "loot" || p.mode === "position" || p.mode === "hunt" || p.mode === "drop" || (p.mode === "fight" && this.modeWhy !== "great"))) {
        const spot = this.retreatSpot
        this.modeWhy = "hold"
        return { ...p, mode: "retreat", dest: spot ? [spot[0], spot[1]] : lk.dest, urgent: true }
      }
      if (lk.mode === "fight" && (p.mode === "loot" || p.mode === "position" || p.mode === "hunt") && p.target && p.target.kind === "mech") {
        this.modeWhy = "hold"
        return { ...p, mode: "fight", dest: null }
      }
    }
    if (p.mode === "retreat" && (!lk || lk.mode !== "retreat" || t >= lk.until)) this.lock = { mode: "retreat", until: t + 2.5, dest: p.dest }
    else if (p.mode === "retreat" && lk) lk.dest = p.dest
    if (p.mode === "fight" && (!lk || lk.mode !== "fight" || t >= lk.until)) this.lock = { mode: "fight", until: t + 1.2, dest: null }
    return p
  }

  decideRaw(): Plan {
    const t = this.t
    const me = this.me
    const hpFrac = me.hp / me.max_hp
    const zone = this.obs.zone
    const zNow = this.zoneNow()
    const dZone = Math.hypot(this.px - zNow.x, this.py - zNow.y)
    this.modeWhy = ""

    // zone timing: how long until the edge reaches us, and how long we need to get to safety
    const safe = this.safePoint()
    const dSafe = Math.hypot(safe[0] - this.px, safe[1] - this.py)
    const speed = (me.stats.walk_speed ?? 11.7) * 0.85
    const travel = (dSafe * 1.3) / speed
    let edgeEta = Infinity
    for (let tau = t; tau < t + 90; tau += 2) {
      const z = zoneAt(zone, tau)
      if (Math.hypot(this.px - z.x, this.py - z.y) > z.r - 8) {
        edgeEta = tau - t
        break
      }
    }
    const outside = dZone > zNow.r - 3
    const zoneUrgent = outside || edgeEta < travel + 10
    const zoneSoon = edgeEta < travel + 25

    // threats
    const threats = this.threats(6)
    const visible = threats.filter((tr) => tr.listed)
    const seeingMe = visible.filter((tr) => this.seesPoint(tr, this.px, this.py, this.pz, this.height) || t - tr.attackedMeT < 2.5)
    const myW = this.myWeapons()
    const myDpsAt = (d: number) => this.loadoutDps(myW, d, me.cubes, me.energy)
    let incomingDps = 0
    for (const tr of seeingMe) incomingDps += this.loadoutDps(tr.weapons, this.dist(tr.x, tr.y), tr.cubes)
    // recent damage rate
    let recentDmg = 0
    for (const d of this.damageLog) if (d.t > t - 3 && d.weapon !== "zone") recentDmg += d.amount
    incomingDps = Math.max(incomingDps, recentDmg / 3)

    // pick a target among shootable things
    const target = this.pickTarget(visible)
    this.targetId = target ? target.id : null

    // evade a laser that is about to fire at us
    const laserThreat = visible.find((tr) => tr.charging && Math.abs(angDiff(Math.atan2(this.py - tr.y, this.px - tr.x), tr.yaw)) < 0.12 && this.seesPoint(tr, this.px, this.py, this.pz, this.height))

    // should we retreat? estimate how a fight goes
    const timeToDie = incomingDps > 1 ? me.hp / incomingDps : Infinity
    let timeToKill = Infinity
    if (target && target.kind === "mech") {
      const d = this.dist(target.x, target.y)
      timeToKill = target.hp / Math.max(1, myDpsAt(d))
    }
    const outnumbered = seeingMe.length >= 2
    // committed duel we're winning on HP: finish it rather than turn and run in the open
    const winning = !outnumbered && !!target && target.kind === "mech" && seeingMe.includes(target) && target.hp < me.hp * 0.75
    const lowHp = (hpFrac < 0.35 && !winning) || (hpFrac < 0.55 && outnumbered)
    const losing = timeToDie < timeToKill * LOSING_RATIO && timeToDie < 12
    const retreat = seeingMe.length > 0 && (lowHp || losing) && !(target && target.hp < 250 && timeToKill < 1.5)

    if (zoneUrgent && (outside || !retreat)) {
      this.modeWhy = outside ? "out" : "eta" + Math.round(edgeEta)
      return { mode: "zone", dest: safe, target, urgent: true, face: null }
    }
    if (retreat) {
      const from = seeingMe.length ? [...seeingMe] : [...visible]
      const ghost = this.unseenAttacker()
      if (ghost) from.push(ghost)
      const spot = this.findCover(from)
      this.modeWhy = lowHp ? "lowhp" : "losing"
      return { mode: "retreat", dest: spot ? [spot[0], spot[1]] : this.awayPoint(from), target, urgent: true, face: null }
    }
    // being shot by someone we can't see: take cover from where it came from (the torso turns to look, scanYaw)
    if (!target || target.kind === "npc" || !seeingMe.includes(target)) {
      const ghost = this.unseenAttacker()
      if (ghost) {
        const spot = this.findCover([ghost])
        this.modeWhy = "unseen"
        return { mode: "retreat", dest: spot ? [spot[0], spot[1]] : this.awayPoint([ghost]), target: null, urgent: true, face: null }
      }
    }
    if (laserThreat && !target) {
      const spot = this.findCover([laserThreat])
      return { mode: "evade", dest: spot ? [spot[0], spot[1]] : null, target, urgent: true, face: null }
    }

    if (target && target.kind === "mech") {
      // engage if it's a good trade; if they're on us and it isn't, break line of sight instead
      const d = this.dist(target.x, target.y)
      const theySee = seeingMe.includes(target)
      const others = visible.filter((tr) => tr !== target && this.dist(tr.x, tr.y) < 150).length
      const theirDps = this.loadoutDps(target.weapons, d, target.cubes)
      const myTtk = target.hp / Math.max(1, myDpsAt(d))
      const theirTtk = me.hp / Math.max(1, theirDps)
      const ratio = theirTtk / Math.max(0.1, myTtk)
      const good = ratio > 1.1 / this.aggression || target.hp < 300
      const great = ratio > 1.6 / this.aggression || target.hp < 250
      if (theySee) {
        if (great || (good && others === 0 && d < 110)) {
          if (great) this.modeWhy = "great"
          return { mode: "fight", dest: null, target, urgent: false, face: null }
        }
        const ghost = this.unseenAttacker()
        const spot = this.findCover(ghost ? [...seeingMe, ghost] : seeingMe)
        if (spot && this.dist(spot[0], spot[1]) > 2) {
          this.modeWhy = "disengage"
          return { mode: "retreat", dest: [spot[0], spot[1]], target, urgent: true, face: null }
        }
        return { mode: "fight", dest: null, target, urgent: false, face: null }
      }
      if ((good && others === 0) || t - target.hitByMeT < 3) {
        return { mode: "fight", dest: null, target, urgent: false, face: null }
      }
    }

    // supply drop?
    const drop = this.dropPlan(threats)
    if (drop) return { mode: "drop", dest: drop, target, urgent: false, face: null }

    // hunt NPCs / shoot crates / grab loot when the coast is clear
    const recentThreat = threats.some((tr) => this.dist(tr.x, tr.y) < 120 && t - tr.lastSeen < 4)
    if (!zoneSoon) {
      const loot = this.lootPlan(recentThreat)
      if (loot) {
        this.modeWhy = loot.why
        return { mode: "loot", dest: loot.dest, target: loot.target ?? target, urgent: false, face: null }
      }
    }
    if (target && target.kind === "npc" && !recentThreat) {
      return { mode: "hunt", dest: this.huntSpot(target), target, urgent: false, face: null }
    }

    // early on, let the opening brawl thin out: sit somewhere hidden near spawn
    if (t < this.lurkUntil && !zoneSoon) {
      const hs = this.lurkSpot()
      if (hs) {
        this.modeWhy = "lurk"
        return { mode: "position", dest: [hs[0], hs[1]], target: target && target.kind === "mech" ? target : null, urgent: false, face: null }
      }
    }
    // default: get to a good spot inside the next circle
    const spot = this.campPoint()
    return { mode: "position", dest: spot, target: target && target.kind === "mech" ? target : null, urgent: zoneSoon, face: null }
  }

  lastHitBearing(): number | null {
    for (let k = this.damageLog.length - 1; k >= 0; k--) {
      const d = this.damageLog[k]
      if (d.weapon !== "zone" && d.bearing !== null) return d.bearing
    }
    return null
  }

  /** a stand-in track for whoever hit us recently without being in view (estimated from the hit bearing) */
  unseenAttacker(): Track | null {
    const t = this.t
    for (let k = this.damageLog.length - 1; k >= 0; k--) {
      const d = this.damageLog[k]
      if (t - d.t > 2.5) break
      if (d.weapon === "zone" || d.weapon === "npc" || d.bearing === null) continue
      const tr = d.by !== null ? this.tracks.get(d.by) : undefined
      if (tr && tr.listed) continue
      const est = d.weapon === "lightning" ? 35 : d.weapon === "mortar" ? 130 : 110
      const x = this.px + Math.cos(d.bearing) * est, y = this.py + Math.sin(d.bearing) * est
      return {
        id: d.by ?? -1, kind: "mech", x, y, z: this.surface(x, y), vx: 0, vy: 0, vz: 0, yaw: d.bearing + Math.PI, pitch: 0,
        hp: 1400, maxHp: 1400, cubes: 0, weapons: [d.weapon], charging: false, firstSeen: t, lastSeen: t, listed: false,
        attackedMeT: d.t, hitByMeT: -99, homeX: x, homeY: y,
      }
    }
    return null
  }

  pickTarget(visible: Track[]): Track | null {
    let best: Track | null = null
    let bestS = -Infinity
    const t = this.t
    const gunRange = this.weapon("gun")?.w.stats.range ?? 230
    const maxRange = Math.max(gunRange, this.weapon("laser") ? this.weapon("laser")!.w.stats.range ?? 280 : 0, this.weapon("mortar") ? 220 : 0)
    // NPCs: only bother if we're healthy and no mechs around
    const mechsNear = visible.some((tr) => tr.kind === "mech")
    for (const tr of this.tracks.values()) {
      if (!tr.listed) continue
      const d = this.dist(tr.x, tr.y)
      if (d > maxRange) continue
      if (tr.kind === "npc") {
        if (mechsNear && t - tr.attackedMeT > 2) continue
        if (this.me.hp < this.me.max_hp * 0.4 && t - tr.attackedMeT > 2) continue
        if (d > 160 && t - tr.attackedMeT > 2) continue
      }
      if (!this.shootable(tr)) continue
      let s = 100 - d * 0.25
      if (tr.kind === "mech") {
        s += 40
        s += (1 - tr.hp / Math.max(1, tr.maxHp)) * 80
        if (t - tr.attackedMeT < 3) s += 50
        if (t - tr.hitByMeT < 2) s += 25
        const facing = Math.abs(angDiff(Math.atan2(this.py - tr.y, this.px - tr.x), tr.yaw))
        if (facing > Math.PI / 2) s += 15
      } else {
        s -= 30
        if (t - tr.attackedMeT < 3) s += 40
        s += (1 - tr.hp / Math.max(1, tr.maxHp)) * 30
      }
      if (tr.id === this.targetId) s += 20
      if (s > bestS) {
        bestS = s
        best = tr
      }
    }
    return best
  }

  /** where to stand inside the next circle */
  safePoint(): V2 {
    const z = this.obs.zone
    const nc = z.next_center, nr = z.next_radius
    const dx = this.px - nc[0], dy = this.py - nc[1]
    const d = Math.hypot(dx, dy)
    // edge-play: aim at a ring inside the next circle on our side, never deep in the middle where the crowd is
    const ringR = nr * 0.55
    if (d <= ringR) return [this.px, this.py]
    const [ux, uy] = d > 1e-6 ? [dx / d, dy / d] : [1, 0]
    return [nc[0] + ux * ringR, nc[1] + uy * ringR]
  }

  campPoint(): V2 {
    const z = this.obs.zone
    const key = `${z.next_center[0].toFixed(0)},${z.next_center[1].toFixed(0)},${z.next_radius.toFixed(0)}`
    if (this.campSpot && this.campKey === key) {
      // re-check it's still in the next circle with some margin
      if (Math.hypot(this.campSpot[0] - z.next_center[0], this.campSpot[1] - z.next_center[1]) < z.next_radius * 0.8) return [this.campSpot[0], this.campSpot[1]]
    }
    this.campKey = key
    const safe = this.safePoint()
    if (!this.world || !this.nav) {
      this.campSpot = [safe[0], safe[1], this.pz]
      return safe
    }
    // sample spots near the safe point; prefer ones next to buildings (half the directions covered) and not too far
    let best: V3 = [safe[0], safe[1], this.surface(safe[0], safe[1])]
    let bestS = -Infinity
    const nr = z.next_radius
    const R = Math.min(60, nr * 0.45)
    for (let k = 0; k < 40; k++) {
      const a = this.rng.next() * Math.PI * 2, r = Math.sqrt(this.rng.next()) * R
      const x = safe[0] + Math.cos(a) * r, y = safe[1] + Math.sin(a) * r
      if (Math.hypot(x - z.next_center[0], y - z.next_center[1]) > nr * 0.8) continue
      const n = this.nav.nodeAt(x, y)
      if (this.nav.blocked[n] || this.nav.roof[n]) continue
      const c = this.nav.clear[n]
      if (c < 3.2) continue
      const h = this.nav.h[n]
      let covered = 0
      for (let q = 0; q < 12; q++) {
        const b = (q / 12) * Math.PI * 2
        if (!this.los(x, y, h + 6, x + Math.cos(b) * 30, y + Math.sin(b) * 30, h + 6)) covered++
      }
      const s = covered * 4 - (c > 8 ? (c - 8) * 0.3 : 0) - r * 0.08
      if (s > bestS) {
        bestS = s
        best = [x, y, h]
      }
    }
    this.campSpot = best
    return [best[0], best[1]]
  }

  /** fraction of surrounding observers (rings at 35/70/120 m, standing on whatever surface is there) that can't see a mech at (x,y,h) */
  concealment(x: number, y: number, h: number): number {
    if (!this.world) return 0
    let hidden = 0, total = 0
    for (const r of [35, 70, 120]) {
      for (let q = 0; q < 12; q++) {
        const b = (q / 12) * Math.PI * 2 + r * 0.013
        const ox = x + Math.cos(b) * r, oy = y + Math.sin(b) * r
        if (!this.world.inBounds(ox, oy, 5)) continue
        const oz = this.world.surface(ox, oy) + 8
        total++
        if (!this.los(ox, oy, oz, x, y, h + 4.5) && !this.los(ox, oy, oz, x, y, h + 8.5)) hidden++
      }
    }
    return total ? hidden / total : 0
  }

  /** a hidden ground spot near where we are (computed once) */
  lurkSpot(): V3 | null {
    if (this.hideSpot) return this.hideSpot
    if (!this.world || !this.nav) return null
    let best: V3 | null = null
    let bestS = -Infinity
    for (let k = 0; k < 30; k++) {
      const a = this.rng.next() * Math.PI * 2, r = k === 0 ? 0 : 8 + Math.sqrt(this.rng.next()) * 45
      const x = this.px + Math.cos(a) * r, y = this.py + Math.sin(a) * r
      const n = this.nav.nodeAt(x, y)
      if (this.nav.blocked[n] || this.nav.roof[n] || this.nav.clear[n] < 3.2) continue
      const h = this.nav.h[n]
      if (Math.abs(h - this.pz) > 3) continue
      if (!this.inZoneAt(x, y, this.lurkUntil + 5, 10)) continue
      const s = this.concealment(x, y, h) * 100 - r * 0.3
      if (s > bestS) {
        bestS = s
        best = [x, y, h]
      }
    }
    this.hideSpot = best
    return best
  }

  /** stand-off point for fighting target */
  fightSpot(tr: Track): V2 {
    const myW = this.myWeapons()
    const theirW = tr.weapons
    let pref = 70
    if (myW.includes("lightning") && this.me.energy > 25 && !theirW.includes("lightning")) pref = 30
    else if (theirW.includes("lightning")) pref = 85
    else if (myW.includes("laser")) pref = 90
    if (myW.includes("mortar") && !myW.includes("lightning") && !myW.includes("laser")) pref = Math.max(pref, 60)
    const dx = this.px - tr.x, dy = this.py - tr.y
    const d = Math.hypot(dx, dy) || 1
    const ux = dx / d, uy = dy / d
    // strafe: rotate around the target, flip side every so often
    if (this.t > this.strafeUntil) {
      this.strafeSign = this.rng.next() < 0.5 ? -1 : 1
      this.strafeUntil = this.t + this.rng.range(0.7, 1.8)
    }
    const ang = Math.atan2(uy, ux) + this.strafeSign * clamp(14 / Math.max(d, 20), 0.08, 0.6)
    const r = d + clamp(pref - d, -12, 12)
    return [tr.x + Math.cos(ang) * r, tr.y + Math.sin(ang) * r]
  }

  /** strafe around a target at a preferred range with irregular direction changes (beats lead prediction) */
  combatMove(tr: Track): { move: V2; boost: boolean } {
    const t = this.t
    const me = this.me
    const myW = this.myWeapons()
    let pref = 70
    if (myW.includes("lightning") && me.energy > 25 && !tr.weapons.includes("lightning")) pref = 28
    else if (tr.weapons.includes("lightning")) pref = 85
    else if (myW.includes("laser")) pref = 90
    if (tr.kind === "npc") pref = 55
    const dx = this.px - tr.x, dy = this.py - tr.y
    const d = Math.hypot(dx, dy) || 1
    const ux = dx / d, uy = dy / d
    if (t > this.strafeUntil) {
      if (this.rng.next() < 0.7) this.strafeSign = -this.strafeSign
      this.strafeUntil = t + this.rng.range(0.35, 1.1)
      this.strafeSpeed = this.rng.next() < 0.25 ? 0.55 : 1
    }
    const radial = clamp((pref - d) / 35, -0.75, 0.75)
    const mk = (sign: number): V2 => norm2(-uy * sign + ux * radial, ux * sign + uy * radial)
    let mv = mk(this.strafeSign)
    const okDir = (v: V2) => {
      if (!this.nav) return true
      const ax = this.px + v[0] * 7, ay = this.py + v[1] * 7
      if (!this.inZoneAt(ax, ay, t + 5, 4)) return false
      return this.nav.walkable(this.px, this.py, this.pz, ax, ay, 1.1, 2.4)
    }
    if (!okDir(mv)) {
      const alt = mk(-this.strafeSign)
      if (okDir(alt)) {
        this.strafeSign = -this.strafeSign
        this.strafeUntil = t + this.rng.range(0.4, 0.9)
        mv = alt
      } else {
        // pinned: back toward the zone centre
        const z = this.zoneNow()
        mv = norm2(z.x - this.px, z.y - this.py)
      }
    }
    const boost = me.grounded && me.energy > 55 && this.rng.next() < 0.35
    return { move: [mv[0] * this.strafeSpeed, mv[1] * this.strafeSpeed], boost }
  }

  huntSpot(tr: Track): V2 {
    // shoot drones from outside their aggro range if possible
    const dx = this.px - tr.x, dy = this.py - tr.y
    const d = Math.hypot(dx, dy) || 1
    const want = 60
    if (Math.abs(d - want) < 15) return [this.px, this.py]
    return [tr.x + (dx / d) * want, tr.y + (dy / d) * want]
  }

  awayPoint(from: Track[]): V2 {
    let ax = 0, ay = 0
    for (const tr of from) {
      const [ux, uy] = norm2(this.px - tr.x, this.py - tr.y)
      ax += ux
      ay += uy
    }
    const [ux, uy] = norm2(ax, ay)
    const z = this.zoneNow()
    // bias toward the zone centre so we don't run out of the circle
    const [zx, zy] = norm2(z.x - this.px, z.y - this.py)
    const [fx, fy] = norm2(ux + zx * 0.5, uy + zy * 0.5)
    return [this.px + fx * 40, this.py + fy * 40]
  }

  /** a nearby spot hidden from all `from` tracks */
  findCover(from: Track[]): V3 | null {
    if (!this.world || !this.nav || from.length === 0) return null
    if (this.retreatSpot && this.t - this.retreatSpotT < 1.0) return this.retreatSpot
    const z = zoneAt(this.obs.zone, this.t + 8)
    let best: V3 | null = null
    let bestS = -Infinity
    const cands: V3[] = [[this.px, this.py, this.pz]]
    for (const r of [7, 13, 20, 28, 38]) {
      const n = r < 15 ? 12 : 16
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + r * 0.1
        const x = this.px + Math.cos(a) * r, y = this.py + Math.sin(a) * r
        const nd = this.nav.nodeAt(x, y)
        if (this.nav.blocked[nd]) continue
        const h = this.nav.h[nd]
        if (h - this.pz > 1.5) continue // no climbing while retreating
        if (!this.nav.roof[nd] && this.nav.clear[nd] < 3) continue
        cands.push([x, y, h])
      }
    }
    for (const c of cands) {
      const [x, y, h] = c
      const d = this.dist(x, y)
      if (c === cands[0]) {
        // staying put only counts if we're already hidden from everyone
        let seen = false
        for (const tr of from) if (this.los(tr.x, tr.y, tr.z + 8, x, y, h + 4.5) || this.los(tr.x, tr.y, tr.z + 8, x, y, h + 8.8)) seen = true
        if (seen) continue
      }
      let hidden = 0
      let minD = Infinity
      for (const tr of from) {
        const eye = tr.z + 8
        const vis = this.los(tr.x, tr.y, eye, x, y, h + 4.5) || this.los(tr.x, tr.y, eye, x, y, h + 8.8)
        if (!vis) hidden++
        minD = Math.min(minD, Math.hypot(x - tr.x, y - tr.y))
      }
      if (hidden === 0) continue
      let s = (hidden / from.length) * 100 - d * 1.2 + Math.min(minD, 150) * 0.15
      if (Math.hypot(x - z.x, y - z.y) > z.r - 5) s -= 150
      if (d > 3 && !this.nav.walkable(this.px, this.py, this.pz, x, y, 1.6, 2.6)) s -= 70
      if (s > bestS) {
        bestS = s
        best = c
      }
    }
    if (best && bestS < 20) best = null
    this.retreatSpot = best
    this.retreatSpotT = this.t
    return best
  }

  dropPlan(threats: Track[]): V2 | null {
    const drops = this.obs.drops ?? []
    const me = this.me
    for (const d of drops) {
      const dd = this.dist(d.pos[0], d.pos[1])
      if (dd > 220 || !this.reachable(d.pos[0], d.pos[1])) continue
      if (d.lands_in > dd / 11 + 8) continue
      if (!this.inZoneAt(d.pos[0], d.pos[1], this.t + 10, 10)) continue
      // someone else already sitting on it with progress: contest only if we are strong
      const near = threats.filter((tr) => Math.hypot(tr.x - d.pos[0], tr.y - d.pos[1]) < 60 && this.t - tr.lastSeen < 4)
      if (near.length >= 2) continue
      if (near.length === 1 && (near[0].hp > me.hp * 0.9 || me.hp < me.max_hp * 0.5)) continue
      if (d.holder !== null && d.holder !== me.id && d.progress > d.capture_s * 0.6 && dd > 40) continue
      if (me.hp < me.max_hp * 0.3 && near.length > 0) continue
      return [d.pos[0], d.pos[1]]
    }
    return null
  }

  lootPlan(threatNear: boolean): { dest: V2; why: string; target?: Track } | null {
    const me = this.me
    const t = this.t
    const zone = this.zoneNow()
    const watchers = this.threats(8).filter((tr) => this.dist(tr.x, tr.y) < 170)
    const exposed = (x: number, y: number) => {
      const h = this.surface(x, y)
      for (const tr of watchers) if (Math.hypot(tr.x - x, tr.y - y) < 170 && this.los(tr.x, tr.y, tr.z + 8, x, y, h + 5)) return true
      return false
    }
    const ok = (x: number, y: number) => Math.hypot(x - zone.x, y - zone.y) < zone.r - 15 && this.inZoneAt(x, y, t + 20, 5) && !exposed(x, y)
    let best: { dest: V2; why: string; target?: Track } | null = null
    let bestS = 0
    // cubes: walk over them
    for (const c of this.cubes.values()) {
      const d = this.dist(c.x, c.y)
      if (d > 120 || !ok(c.x, c.y) || !this.reachable(c.x, c.y)) continue
      if (Math.abs(c.z - this.pz) > 25) continue
      const s = 60 - d * 0.4
      if (s > bestS) {
        bestS = s
        best = { dest: [c.x, c.y], why: "cube" }
      }
    }
    // weapons
    const ws = me.weapons
    const have = new Set(this.myWeapons())
    const slot1 = ws[1]
    const curRank = slot1 ? WEAPON_RANK[slot1.kind] ?? 0 : -1
    for (const p of this.pickups.values()) {
      if (this.ignorePickup.has(p.id)) continue
      if (have.has(p.kind)) continue
      const rank = WEAPON_RANK[p.kind] ?? 0
      if (p.kind === "gun") continue
      if (rank <= curRank) continue
      const d = this.dist(p.x, p.y)
      const maxD = slot1 ? 70 : t < this.lurkUntil ? 100 : 220
      if (d > maxD || !ok(p.x, p.y) || !this.reachable(p.x, p.y)) continue
      if (p.z - this.pz > 30) continue
      const s = (slot1 ? 40 : 90) + rank * 12 - d * 0.3
      if (s > bestS) {
        bestS = s
        best = { dest: [p.x, p.y], why: p.kind }
      }
    }
    if (threatNear && bestS < 40) return null
    // crates: shoot them from range, then the cube/weapon shows up as items
    if (!threatNear && me.hp > me.max_hp * 0.5 && t >= this.lurkUntil) {
      for (const c of this.crates.values()) {
        const d = this.dist(c.x, c.y)
        if (d > 110 || !ok(c.x, c.y)) continue
        if (c.z - this.pz > 20) continue
        // rooftop crates only when we can already see them from here
        const raised = this.world ? c.z - this.world.ground(c.x, c.y) > 2 : false
        if (raised && !this.los(this.px, this.py, this.pz + this.muzH, c.x, c.y, c.z + 1.2)) continue
        const s = 35 - d * 0.25
        if (s > bestS) {
          bestS = s
          // stand ~20 m from it
          const [ux, uy] = norm2(this.px - c.x, this.py - c.y)
          const dest: V2 = d > 25 ? [c.x + ux * 18, c.y + uy * 18] : [this.px, this.py]
          best = { dest, why: "crate" }
        }
      }
    }
    return best
  }

  lootAction(): { take: number; drop?: number } | null {
    const me = this.me
    const reach = this.cfg.loot.pickup_radius ?? 4
    const ws = me.weapons
    const have = new Set(this.myWeapons())
    let best: Item | null = null
    let bestRank = -1
    for (const p of this.obs.pickups) {
      if (this.ignorePickup.has(p.id)) continue
      if (Math.hypot(p.pos[0] - this.px, p.pos[1] - this.py) > reach - 0.3) continue
      if (Math.abs(p.pos[2] - this.pz) > 3.8) continue
      if (have.has(p.kind)) continue
      const rank = WEAPON_RANK[p.kind] ?? 0
      if (rank > bestRank) {
        bestRank = rank
        best = { id: p.id, kind: p.kind, x: p.pos[0], y: p.pos[1], z: p.pos[2], t: this.t, hp: 0 }
      }
    }
    if (!best) return null
    if (best.kind === "gun") {
      // take a gun back only if we have no gun and a free slot
      if (!have.has("gun") && (!ws[0] || !ws[1])) return { take: best.id }
      return null
    }
    if (!ws[0] || !ws[1]) return { take: best.id }
    // both full: swap the special in slot 1 (never drop the gun) if this one ranks higher
    const s1 = ws[1]!
    if ((WEAPON_RANK[s1.kind] ?? 0) < bestRank && !(s1.kind === "laser" && (s1.charge ?? 0) > 0)) return { take: best.id, drop: 1 }
    return null
  }

  pickUpgrade(offer: NonNullable<Observation["offer"]>): number {
    let best = 0, bestR = Infinity
    offer.choices.forEach((c, i) => {
      let r = UPGRADE_PRIORITY.indexOf(c.id)
      if (r < 0) r = 50
      if (r < bestR) {
        bestR = r
        best = i
      }
    })
    return best
  }

  // ------------------------------------------------------------------ movement
  movement(plan: Plan): { move: V2; boost: boolean; jump: boolean } {
    const me = this.me
    let move: V2 = [0, 0]
    let boost = false
    let jump = false
    const t = this.t
    const dest = plan.dest

    if (dest) {
      const fleeing = plan.mode === "retreat" || plan.mode === "evade"
      const nv = this.navigate(dest[0], dest[1], plan.mode === "fight" ? 2.5 : fleeing ? 2 : 4, fleeing && this.t - this.lastDamageT < 6)
      move = nv.move
      jump = nv.jump
      boost = nv.jet
      if (fleeing && Math.hypot(move[0], move[1]) < 0.1 && this.t - this.lastDamageT < 1.2) {
        // at the "cover" spot but still getting hit: keep moving, sideways to the incoming fire
        const b = this.lastHitBearing()
        if (b !== null) {
          if (this.t > this.strafeUntil) {
            this.strafeSign = -this.strafeSign
            this.strafeUntil = this.t + this.rng.range(0.4, 0.9)
          }
          move = [-Math.sin(b) * this.strafeSign, Math.cos(b) * this.strafeSign]
          this.retreatSpotT = -99 // re-evaluate cover next tick
        }
      }
    } else if (plan.mode === "fight" && plan.target) {
      const cm = this.combatMove(plan.target)
      move = cm.move
      boost = cm.boost
    }

    // dodge incoming mortar shells
    const dodge = this.dodgeShells()
    if (dodge) {
      move = dodge
      if (me.energy > 25 && me.grounded) boost = true
    }

    const speedNow = Math.hypot(me.vel[0], me.vel[1])
    const wantMove = Math.hypot(move[0], move[1]) > 0.3
    // ground boost when it matters and energy allows
    if (wantMove && me.grounded && !jump) {
      const reserve = Math.max(35, this.climbNeedAhead + 15)
      if ((plan.urgent && me.energy > reserve) || (plan.mode === "retreat" && me.energy > 20) || (plan.mode === "evade" && me.energy > 15)) boost = true
      if (plan.mode === "zone" && !me.in_zone && me.energy > Math.max(10, this.climbNeedAhead + 5)) boost = true
    }

    // stuck detection: wanted to move, barely moved
    if (wantMove && !this.climbing) {
      const moved = Math.hypot(this.px - this.lastProgressPos[0], this.py - this.lastProgressPos[1])
      if (moved > 3) {
        this.lastProgressPos = [this.px, this.py]
        this.lastProgressT = t
      } else if (t - this.lastProgressT > 1.2 && speedNow < 3) {
        if (this.stuckSince < 0) this.stuckSince = t
        // try a hop first, then a sideways shuffle with a replan; if we're hung up in the air, jet
        if (me.grounded && me.energy > 15) jump = true
        else if (!me.grounded && Math.abs(me.vel[2]) < 1 && me.energy > 5) boost = true
        if (t - this.stuckSince > 1.5 && t > this.unstickUntil) {
          const a = this.rng.range(-Math.PI, Math.PI)
          this.unstickDir = [Math.cos(a), Math.sin(a)]
          this.unstickUntil = t + 0.8
          this.path = null
        }
      }
    } else {
      this.lastProgressPos = [this.px, this.py]
      this.lastProgressT = t
      this.stuckSince = -1
    }
    if (t < this.unstickUntil) {
      move = this.unstickDir
      if (!me.grounded && me.energy > 20) boost = true
    }
    // laser charging halves speed anyway; keep movement
    return { move, boost, jump }
  }

  /** follow an A* path toward (gx, gy). Handles climbing (jump + jet) onto higher nodes. */
  navigate(gx: number, gy: number, arriveR: number, noClimb = false): { move: V2; jump: boolean; jet: boolean; arrived: boolean } {
    const me = this.me
    const d = this.dist(gx, gy)
    if (d < arriveR) {
      this.climbing = false
      return { move: [0, 0], jump: false, jet: false, arrived: true }
    }
    if (!this.nav || !this.world) {
      const [ux, uy] = norm2(gx - this.px, gy - this.py)
      return { move: [ux, uy], jump: false, jet: false, arrived: false }
    }
    const nav = this.nav
    const t = this.t
    // direct when the straight line is walkable and short
    if (d < 60 && nav.walkable(this.px, this.py, this.pz, gx, gy, 1.1, 2.6)) {
      this.climbing = false
      this.climbNeedAhead = 0
      const [ux, uy] = norm2(gx - this.px, gy - this.py)
      return { move: [ux, uy], jump: false, jet: false, arrived: false }
    }
    const goalMoved = !this.pathGoal || Math.hypot(this.pathGoal[0] - gx, this.pathGoal[1] - gy) > Math.max(6, d * 0.15) || noClimb !== this.pathNoClimb
    this.pathNoClimb = noClimb
    let offPath = false
    if (this.path && this.pathIdx < this.path.length) {
      const w = this.path[this.pathIdx]
      if (Math.hypot(w[0] - this.px, w[1] - this.py) > 14 && !this.climbing) offPath = true
    }
    const needPlan = !this.path || goalMoved || offPath || t - this.pathT > 3 || this.pathIdx >= this.path.length
    // over budget this tick: keep the old path (or go straight) and plan next tick
    if (needPlan && this.elapsed() > 20 && this.path) {
    } else if (needPlan && this.elapsed() > 20) {
      const [ux, uy] = norm2(gx - this.px, gy - this.py)
      return { move: [ux, uy], jump: false, jet: false, arrived: false }
    } else if (needPlan) {
      const z = zoneAt(this.obs.zone, t + 10)
      const maxClimb = noClimb ? 2.4 : clamp((me.energy - 10) / 1.5 + 3, 2.5, 40)
      this.path = nav.plan(this.px, this.py, this.pz, gx, gy, {
        zone: z,
        zonePenalty: 2 + this.obs.zone.dps / 20,
        maxClimb: noClimb ? maxClimb : Math.max(maxClimb, 12),
        climbCost: 3,
        avoid: this.avoidSpots.length ? (this.avoidSpots = this.avoidSpots.filter((a) => a.until > t)) : undefined,
        maxExpand: this.mode === "zone" || this.mode === "position" ? 32000 : 20000,
      })
      if (!nav.lastReached) this.unreachable.set(this.ukey(gx, gy), t + 25)
      this.pathGoal = [gx, gy]
      this.pathT = t
      this.pathIdx = 0
    }
    const path = this.path
    if (!path || path.length === 0) {
      const [ux, uy] = norm2(gx - this.px, gy - this.py)
      return { move: [ux, uy], jump: false, jet: false, arrived: false }
    }
    // advance along the path
    while (this.pathIdx < path.length - 1) {
      const w = path[this.pathIdx]
      const close = Math.hypot(w[0] - this.px, w[1] - this.py) < 3.2
      if (close && this.pz > w[2] - 1.5) this.pathIdx++
      else break
    }
    // skip nodes we're past: closest node among the next few
    let bestK = this.pathIdx, bestD = Infinity
    for (let k = this.pathIdx; k < Math.min(path.length, this.pathIdx + 8); k++) {
      // never skip past a node we still have to climb onto (mid-jump, nodes beyond a wall look "reachable")
      if (path[k][2] > this.pz + 1.0) break
      const dd = Math.hypot(path[k][0] - this.px, path[k][1] - this.py)
      if (dd < bestD && this.pz > path[k][2] - 1.5) {
        bestD = dd
        bestK = k
      }
    }
    this.pathIdx = Math.max(this.pathIdx, bestK)
    // energy we'll want for the biggest climb in the next ~60 m of path (so we don't spend it boosting)
    this.climbNeedAhead = 0
    {
      let prevH = this.pz
      let walked = 0
      for (let k = this.pathIdx; k < path.length && walked < 60; k++) {
        const dh = path[k][2] - prevH
        if (dh > 2.2) this.climbNeedAhead = Math.max(this.climbNeedAhead, this.climbEnergy(dh))
        if (k > this.pathIdx) walked += Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1])
        prevH = path[k][2]
      }
    }
    // climbing: is the next stretch much higher than our feet? (a wall is often 2-3 nodes: base, rim, top)
    let next = path[this.pathIdx]
    for (let k = this.pathIdx + 1; k < Math.min(path.length, this.pathIdx + 4); k++) {
      if (Math.hypot(path[k][0] - this.px, path[k][1] - this.py) > 9) break
      if (path[k][2] > next[2]) next = path[k]
    }
    const rise = next[2] - this.pz
    if (rise > 1.0) {
      const hd = Math.hypot(next[0] - this.px, next[1] - this.py)
      const need = this.climbEnergy(rise)
      const [ux, uy] = norm2(next[0] - this.px, next[1] - this.py)
      if (this.climbing && t - this.climbStart > 7) {
        // this climb isn't working: give up on this goal and route around this wall for a while
        this.climbing = false
        this.unreachable.set(this.ukey(gx, gy), t + 30)
        this.avoidSpots.push({ x: next[0], y: next[1], r: 7, cost: 40, until: t + 30 })
        this.path = null
        const [vx, vy] = norm2(this.px - next[0], this.py - next[1])
        return { move: [vx, vy], jump: false, jet: false, arrived: false }
      }
      if (hd < 7 || this.climbing) {
        if (me.grounded) {
          if (rise <= 2.2 || me.energy >= Math.min(need, me.max_energy * 0.95)) {
            if (!this.climbing) this.climbStart = t
            this.climbing = true
            this.climbTarget = next[2]
            return { move: [ux, uy], jump: true, jet: false, arrived: false }
          }
          // wait for energy near the wall
          return { move: [0, 0], jump: false, jet: false, arrived: false }
        }
        // in the air: jet until feet clear the edge, keep pushing toward it
        const jet = this.pz < next[2] + 0.8 && me.energy > 1
        return { move: [ux, uy], jump: false, jet, arrived: false }
      }
    }
    if (me.grounded) this.climbing = false
    // look ahead along the path for the furthest node we can walk to straight
    let aim = this.pathIdx
    for (let k = this.pathIdx + 1; k < Math.min(path.length, this.pathIdx + 14); k++) {
      if (path[k][2] - this.pz > 1.0) break
      if (!nav.walkable(this.px, this.py, this.pz, path[k][0], path[k][1], 1.1, 2.6)) break
      aim = k
    }
    const w = path[aim]
    const [ux, uy] = norm2(w[0] - this.px, w[1] - this.py)
    // airborne without wanting to climb: no jets
    return { move: [ux, uy], jump: false, jet: false, arrived: false }
  }

  /** energy to climb `rise` metres: the jump gives ~2.5 m for free, jets rise at max_rise_speed */
  climbEnergy(rise: number): number {
    const st = this.me.stats
    const jetRise = Math.max(0, rise + 0.8 - 2.5)
    return (jetRise / (st.max_rise_speed ?? 10)) * (st.jet_drain ?? 15) * 1.25 + 6
  }

  dodgeShells(): V2 | null {
    const g = this.cfg.weapons.mortar.gravity ?? 22
    for (const p of this.obs.projectiles) {
      if (p.kind !== "mortar") continue
      // simulate to the ground
      let [x, y, z] = p.pos
      let [vx, vy, vz] = p.vel
      let tt = 0
      for (let k = 0; k < 160; k++) {
        const dt = 0.05
        x += vx * dt
        y += vy * dt
        z += vz * dt - 0.5 * g * dt * dt
        vz -= g * dt
        tt += dt
        if (z < this.surface(x, y)) break
      }
      const myX = this.px + this.me.vel[0] * tt, myY = this.py + this.me.vel[1] * tt
      const dd = Math.hypot(myX - x, myY - y)
      if (dd < 11 && tt < 4) {
        const [ux, uy] = norm2(this.px - x, this.py - y)
        return dd > 0.5 ? [ux, uy] : [-p.vel[1], p.vel[0]].map((v) => v / Math.max(1e-6, Math.hypot(p.vel[0], p.vel[1]))) as V2
      }
    }
    return null
  }

  // ------------------------------------------------------------------ aim & fire
  aimAndFire(plan: Plan): { aim: V2; fire: [boolean, boolean]; reload: boolean } {
    const me = this.me
    const t = this.t
    const fire: [boolean, boolean] = [false, false]
    let reload = false
    const [ayaw, apitch] = me.aim
    const mz = this.pz + this.muzH
    let aim: V2 = [ayaw, 0]

    const target = plan.target
    const gun = this.weapon("gun")
    const laser = this.weapon("laser")
    const lightning = this.weapon("lightning")
    const mortar = this.weapon("mortar")

    // crate shooting when looting crates
    let crateTarget: Item | null = null
    if (!target && plan.mode === "loot" && this.modeWhy === "crate" && t - this.lastDamageT > 3) {
      let bd = Infinity
      for (const c of this.obs.crates) {
        const d = this.dist(c.pos[0], c.pos[1])
        if (d < 120 && d < bd && this.los(this.px, this.py, mz, c.pos[0], c.pos[1], c.pos[2] + 1.2)) {
          bd = d
          crateTarget = { id: c.id, kind: "crate", x: c.pos[0], y: c.pos[1], z: c.pos[2], t, hp: c.hp ?? 300 }
        }
      }
    }

    if (target || crateTarget) {
      let tx: number, ty: number, tz: number, tvx = 0, tvy = 0, tvz = 0, radius: number
      if (target) {
        ;[tx, ty, tz] = this.center(target)
        tvx = target.vx
        tvy = target.vy
        tvz = target.vz
        radius = target.kind === "npc" ? this.cfg.npc.radius ?? 1.8 : 2.5 * this.scaleOf(target.cubes)
      } else {
        tx = crateTarget!.x
        ty = crateTarget!.y
        tz = crateTarget!.z + 1.2
        radius = this.cfg.crates?.radius ?? 1.4
      }
      const d3 = Math.hypot(tx - this.px, ty - this.py, tz - mz)
      // gun lead
      const gspeed = gun?.w.stats.speed ?? 252
      let lt = Math.max(0, d3 - 3) / gspeed + 0.05
      let px = tx, py = ty, pzz = tz
      for (let k = 0; k < 3; k++) {
        px = tx + tvx * lt
        py = ty + tvy * lt
        pzz = tz + (Math.abs(tvz) > 0.5 ? tvz * lt - 0.5 * 22 * lt * lt * 0.5 : 0)
        lt = Math.max(0, Math.hypot(px - this.px, py - this.py, pzz - mz) - 3) / gspeed + 0.05
      }
      const gunYaw = Math.atan2(py - this.py, px - this.px)
      const gunPitch = Math.atan2(pzz - mz, Math.hypot(px - this.px, py - this.py))
      // laser: hitscan, tiny lead for the decision latency
      const lx = tx + tvx * 0.07, ly = ty + tvy * 0.07
      const laserYaw = Math.atan2(ly - this.py, lx - this.px)
      const laserPitch = Math.atan2(tz - mz, Math.hypot(lx - this.px, ly - this.py))
      const angTol = Math.atan2(radius * 0.75, Math.max(5, d3))

      aim = [gunYaw, gunPitch]
      const laserCharging = laser && (laser.w.charge ?? 0) > 0
      if (laser && target && (laserCharging || laser.w.cooldown < 0.3)) aim = [laserYaw, laserPitch]

      // mortar: lob when we can't shoot it directly, or as a bonus vs slow targets far away
      let mortarSol: { yaw: number; pitch: number } | null = null
      if (mortar && target && mortar.w.cooldown <= 0.3 && !laserCharging) {
        const dd = this.dist(tx, ty)
        if (dd > 25 && dd < 230 && (!lightning || dd > 45)) {
          mortarSol = this.mortarSolve(target, mortar.w)
        }
      }
      if (mortarSol && (t < this.mortarAimUntil || !this.shootable(target!) || !gun || (gun.w.ammo ?? 1) === 0 || Math.hypot(target!.vx, target!.vy) < 3)) {
        if (t >= this.mortarAimUntil) this.mortarAimUntil = t + 0.8
        aim = [mortarSol.yaw, mortarSol.pitch]
        if (Math.abs(angDiff(ayaw, mortarSol.yaw)) < 0.03 && Math.abs(apitch - mortarSol.pitch) < 0.03 && mortar!.w.cooldown <= 0) {
          fire[mortar!.slot] = true
          this.mortarAimUntil = -1
        }
      }

      const clearShot = target ? this.shootable(target) : true
      // gun
      const tgtSpeed = Math.hypot(tvx, tvy)
      const likely = d3 < 135 || tgtSpeed < 4 || !target || target.kind === "npc" || (d3 < 175 && target.hp < 400)
      if (gun && clearShot && likely && d3 < (gun.w.stats.range ?? 230) - 5) {
        const err = Math.hypot(angDiff(ayaw, gunYaw) * Math.cos(gunPitch), apitch - gunPitch)
        if (err < angTol + 0.01 && (gun.w.reload ?? 0) <= 0 && (gun.w.ammo ?? 1) > 0) fire[gun.slot] = true
      }
      // laser
      if (laser && target && t > this.shortUntil) {
        const w = laser.w
        const full = w.stats.charge ?? 0.75
        const charge = w.charge ?? 0
        const inRange = d3 < (w.stats.range ?? 280) - 5
        if (charge > 0) {
          const err = Math.hypot(angDiff(ayaw, laserYaw) * Math.cos(laserPitch), apitch - laserPitch)
          const hold = w.stats.hold_s ?? 2
          if (charge >= full - 0.02 && err < angTol && clearShot) {
            fire[laser.slot] = false // release: fire
          } else if (charge > full + hold - 0.25) {
            fire[laser.slot] = false
          } else fire[laser.slot] = true
        } else if (w.cooldown <= 0.05 && clearShot && inRange && plan.mode !== "retreat") {
          fire[laser.slot] = true // start charging
        }
      }
      // lightning: nearest thing in the cone gets it; fire when our target is in the cone and in range
      if (lightning && target) {
        const w = lightning.w
        const range = w.stats.range ?? 45
        const cone = ((w.stats.cone_deg ?? 30) * Math.PI) / 180
        const dd = this.dist(tx, ty)
        if (dd < range - 1 && Math.abs(angDiff(ayaw, Math.atan2(ty - this.py, tx - this.px))) < cone * 0.45 && clearShot && w.cooldown <= 0 && me.energy > (w.stats.energy ?? 3) + 8) {
          fire[lightning.slot] = true
        }
      }
      if (fire[0] || fire[1]) this.lastFireT = t
    } else {
      // no target: keep a laser charge? release it if one is going
      if (laser && (laser.w.charge ?? 0) > 0) {
        const w = laser.w
        // hold until near auto-fire in case the target reappears
        fire[laser.slot] = (laser.w.charge ?? 0) < (w.stats.charge ?? 0.75) + (w.stats.hold_s ?? 2) - 0.3
      }
      aim = [this.scanYaw(plan), 0]
      // reload when quiet
      if (gun && (gun.w.ammo ?? 12) < (gun.w.stats.mag ?? 12) * 0.6 && (gun.w.reload ?? 0) <= 0 && t - this.lastFireT > 1.5) reload = true
    }
    if (gun && (gun.w.ammo ?? 1) === 0 && (gun.w.reload ?? 0) <= 0) reload = true
    aim[1] = clamp(aim[1], me.stats.min_pitch ?? -0.7, me.stats.max_pitch ?? 1.3)
    aim[0] = wrap(aim[0])
    return { aim, fire, reload }
  }

  mortarSolve(tr: Track, w: WeaponObs): { yaw: number; pitch: number } | null {
    const v = w.stats.speed ?? 72
    const g = w.stats.gravity ?? 22
    const oz = this.pz + this.height + 0.5
    // iterate on flight time for lead
    let tx = tr.x, ty = tr.y
    const tz = tr.z + 1
    let sol: { yaw: number; pitch: number } | null = null
    for (let it = 0; it < 3; it++) {
      const R = Math.hypot(tx - this.px, ty - this.py) - 3
      const H = tz - oz
      const disc = v ** 4 - g * (g * R * R + 2 * H * v * v)
      if (disc < 0 || R < 5) return null
      const yaw = Math.atan2(ty - this.py, tx - this.px)
      const lowP = Math.atan((v * v - Math.sqrt(disc)) / (g * R))
      const highP = Math.atan((v * v + Math.sqrt(disc)) / (g * R))
      let chosen: number | null = null
      for (const p of [lowP, highP]) {
        if (p > (this.me.stats.max_pitch ?? 1.3) || p < (this.me.stats.min_pitch ?? -0.7)) continue
        if (this.mortarPathClear(yaw, p, v, g, tx, ty, tz)) {
          chosen = p
          break
        }
      }
      if (chosen === null) return null
      const ft = R / (v * Math.cos(chosen))
      sol = { yaw, pitch: chosen }
      const lead = Math.min(ft, 3) * 0.7
      tx = tr.x + tr.vx * lead
      ty = tr.y + tr.vy * lead
    }
    return sol
  }

  mortarPathClear(yaw: number, pitch: number, v: number, g: number, tx: number, ty: number, tz: number): boolean {
    if (!this.world) return true
    const cx = Math.cos(yaw) * Math.cos(pitch), cy = Math.sin(yaw) * Math.cos(pitch), cz = Math.sin(pitch)
    let x = this.px + cx * 3, y = this.py + cy * 3, z = this.pz + this.height + 0.5 + cz * 3
    let vx = cx * v, vy = cy * v, vz = cz * v
    const dt = 0.1
    for (let k = 0; k < 80; k++) {
      const nx = x + vx * dt, ny = y + vy * dt, nz = z + vz * dt - 0.5 * g * dt * dt
      vz -= g * dt
      const f = this.world.raycast(x, y, z, nx, ny, nz)
      if (f < 1) {
        const hx = x + (nx - x) * f, hy = y + (ny - y) * f
        return Math.hypot(hx - tx, hy - ty) < 5 && Math.hypot(hx - this.px, hy - this.py) > 14
      }
      x = nx
      y = ny
      z = nz
      if (z < tz - 30) return false
    }
    return false
  }

  /** torso yaw when there's nothing to shoot: look at what's dangerous, else sweep */
  scanYaw(plan: Plan): number {
    const t = this.t
    // recent damage from someone we can't see
    for (let k = this.damageLog.length - 1; k >= 0; k--) {
      const d = this.damageLog[k]
      if (t - d.t > 2.5) break
      if (d.bearing !== null && d.weapon !== "zone") return d.bearing
    }
    // a remembered threat
    let best: Track | null = null
    let bd = Infinity
    for (const tr of this.tracks.values()) {
      if (tr.kind !== "mech" || t - tr.lastSeen > 6) continue
      const d = this.dist(tr.x, tr.y)
      if (d < bd) {
        bd = d
        best = tr
      }
    }
    if (best && bd < 200) return Math.atan2(best.y - this.py, best.x - this.px)
    // recent weapon sounds nearby
    for (let k = this.sounds.length - 1; k >= 0; k--) {
      const s = this.sounds[k]
      if (t - s.t > 2) break
      if ((s.dist === "near" || s.dist === "mid") && s.kind !== "death" && s.kind !== "drop" && s.kind !== "crate") return s.bearing
    }
    // sweep around our heading
    const v = this.me.vel
    const moving = Math.hypot(v[0], v[1]) > 3
    const base = moving ? Math.atan2(v[1], v[0]) : this.lookYaw
    this.scanPhase += 0.1
    if (!moving) {
      // stationary: rotate slowly to cover all sides
      this.lookYaw = wrap(this.lookYaw + 0.12)
      return this.lookYaw
    }
    this.lookYaw = base
    return wrap(base + Math.sin(this.scanPhase * 0.9) * 1.0)
  }
}
