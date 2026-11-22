/**
 * Stand-in opponents for local matches. "brawler" approximates what the recorded built-in bot did:
 * head for the zone, grab the closest weapon, attack the nearest mech it sees with leads, laser charges,
 * lightning up close and mortar lobs, strafing while it fights. "example" is the kit's example bot.
 */
import type { Hello, Observation } from "../src/mechfight.ts"
import type { Nav } from "../src/nav.ts"
import { angDiff, norm2, Rng, wrap } from "../src/util.ts"

export class Brawler {
  name = "brawler"
  rng: Rng
  path: [number, number, number][] | null = null
  pathT = -99
  pathGoal: [number, number] = [0, 0]
  idx = 0
  strafe = 1
  strafeT = 0
  roam: [number, number] | null = null
  constructor(public hello: Hello, public nav: Nav | null, public skill = 1) {
    this.rng = new Rng(hello.seed)
  }
  act(obs: Observation) {
    const me = obs.self
    const [x, y, z] = me.pos
    const act: any = {}
    if (obs.offer) act.pick = 0
    const t = obs.t
    // loot
    const reach = this.hello.config.loot.pickup_radius
    const have = new Set(me.weapons.filter((w) => w).map((w) => w!.kind))
    const near = obs.pickups.filter((p) => !have.has(p.kind) && p.kind !== "gun")
    near.sort((a, b) => Math.hypot(a.pos[0] - x, a.pos[1] - y) - Math.hypot(b.pos[0] - x, b.pos[1] - y))
    if (!me.weapons[1] && near.length && Math.hypot(near[0].pos[0] - x, near[0].pos[1] - y) < reach - 0.3) act.take = near[0].id
    // goal
    let goal: [number, number] = [obs.zone.next_center[0], obs.zone.next_center[1]]
    const zr = obs.zone.next_radius
    if (Math.hypot(x - goal[0], y - goal[1]) < zr * 0.5) {
      if (!this.roam || Math.hypot(this.roam[0] - x, this.roam[1] - y) < 8 || Math.hypot(this.roam[0] - goal[0], this.roam[1] - goal[1]) > zr * 0.6) {
        const a = this.rng.next() * Math.PI * 2, r = this.rng.next() * zr * 0.5
        this.roam = [goal[0] + Math.cos(a) * r, goal[1] + Math.sin(a) * r]
      }
      goal = this.roam
    }
    if (!me.weapons[1] && near.length && Math.hypot(near[0].pos[0] - x, near[0].pos[1] - y) < 120) goal = [near[0].pos[0], near[0].pos[1]]
    const enemies = obs.mechs.filter((m) => m.kind === "mech").sort((a, b) => Math.hypot(a.pos[0] - x, a.pos[1] - y) - Math.hypot(b.pos[0] - x, b.pos[1] - y))
    const npcs = obs.mechs.filter((m) => m.kind === "npc" && Math.hypot(m.pos[0] - x, m.pos[1] - y) < 60)
    const tgt = enemies[0] ?? npcs[0]
    let aim: [number, number] = [Math.atan2(goal[1] - y, goal[0] - x), 0]
    const fire: [boolean, boolean] = [false, false]
    let move: [number, number]
    if (tgt) {
      const d = Math.hypot(tgt.pos[0] - x, tgt.pos[1] - y)
      const mz = z + 7
      const tz = tgt.pos[2] + (tgt.kind === "npc" ? 1.75 : 4.5)
      const lt = d / 252
      const px = tgt.pos[0] + tgt.vel[0] * lt * this.skill, py = tgt.pos[1] + tgt.vel[1] * lt * this.skill
      aim = [Math.atan2(py - y, px - x), Math.atan2(tz - mz, d)]
      const err = Math.abs(angDiff(me.aim[0], aim[0]))
      for (let s = 0; s < 2; s++) {
        const w = me.weapons[s]
        if (!w) continue
        if (w.kind === "gun") fire[s] = err < 0.05 && d < 220
        else if (w.kind === "laser") {
          const ch = w.charge ?? 0
          fire[s] = d < 270 && !(ch >= (w.stats.charge ?? 0.75) && err < 0.03)
        } else if (w.kind === "lightning") fire[s] = d < 44 && err < 0.2
        else if (w.kind === "mortar" && d > 30 && d < 220) {
          const v = w.stats.speed, g = w.stats.gravity
          const s2 = Math.min(1, (g * d) / (v * v))
          const p = 0.5 * Math.asin(s2)
          aim = [aim[0], p]
          fire[s] = err < 0.04 && Math.abs(me.aim[1] - p) < 0.04
        }
      }
      if (this.rng.next() < 0.05 || t > this.strafeT) {
        this.strafe = -this.strafe
        this.strafeT = t + 0.8 + this.rng.next() * 1.2
      }
      const [ux, uy] = norm2(tgt.pos[0] - x, tgt.pos[1] - y)
      const radial = d > 90 ? 0.6 : d < 40 ? -0.5 : 0
      move = [-uy * this.strafe + ux * radial, ux * this.strafe + uy * radial]
      act.boost = me.energy > 50 && this.rng.next() < 0.3
      if (me.grounded && this.rng.next() < 0.03) act.jump = true
    } else {
      move = this.follow(goal, x, y, z, t)
      // look around
      aim = [wrap(Math.atan2(move[1], move[0]) + Math.sin(t * 0.7) * 0.9), 0]
      act.boost = !me.in_zone
    }
    // stuck: hop
    if (Math.hypot(me.vel[0], me.vel[1]) < 1 && me.grounded && Math.hypot(move[0], move[1]) > 0.5 && this.rng.next() < 0.2) {
      act.jump = true
      act.boost = true
    }
    if (!me.grounded && me.vel[2] < 3 && Math.hypot(me.vel[0], me.vel[1]) < 2 && me.energy > 20) act.boost = true
    act.move = move
    act.aim = aim
    act.fire = fire
    const g = me.weapons.find((w) => w && w.kind === "gun")
    if (g && g.ammo === 0) act.reload = true
    return act
  }
  follow(goal: [number, number], x: number, y: number, z: number, t: number): [number, number] {
    const nav = this.nav
    if (!nav) return norm2(goal[0] - x, goal[1] - y)
    if (!this.path || t - this.pathT > 3 || Math.hypot(goal[0] - this.pathGoal[0], goal[1] - this.pathGoal[1]) > 10) {
      this.path = nav.plan(x, y, z, goal[0], goal[1], { maxExpand: 40000, maxClimb: 3 })
      this.pathT = t
      this.pathGoal = goal
      this.idx = 0
    }
    const p = this.path
    if (!p || !p.length) return norm2(goal[0] - x, goal[1] - y)
    while (this.idx < p.length - 1 && Math.hypot(p[this.idx][0] - x, p[this.idx][1] - y) < 4) this.idx++
    let k = this.idx
    for (let j = this.idx + 1; j < Math.min(p.length, this.idx + 8); j++) if (nav.walkable(x, y, z, p[j][0], p[j][1], 1.1, 2.6)) k = j
    return norm2(p[k][0] - x, p[k][1] - y)
  }
}

/** the kit's example bot, ported */
export class Example {
  name = "example"
  constructor(public hello: Hello) {}
  act(obs: Observation) {
    const me = obs.self
    const [x, y, z] = me.pos
    const goal = obs.zone.next_center
    const act: any = {}
    if (obs.offer) act.pick = 0
    const reach = this.hello.config.loot.pickup_radius
    const near = obs.pickups.filter((p) => Math.hypot(p.pos[0] - x, p.pos[1] - y) < reach)
    if (!me.weapons[1] && near.length && near[0].kind !== "gun") act.take = near[0].id
    const enemies = obs.mechs.filter((m) => m.kind === "mech").sort((a, b) => Math.hypot(a.pos[0] - x, a.pos[1] - y) - Math.hypot(b.pos[0] - x, b.pos[1] - y))
    const yaw = Math.atan2(goal[1] - y, goal[0] - x)
    Object.assign(act, { move: [Math.cos(yaw), Math.sin(yaw)], aim: [yaw, 0], boost: !me.in_zone, jump: obs.tick % 40 === 0 })
    if (enemies.length) {
      const tp = enemies[0].pos
      act.aim = [Math.atan2(tp[1] - y, tp[0] - x), Math.atan2(tp[2] - z - 2.5, Math.hypot(tp[0] - x, tp[1] - y))]
      act.fire = [true, true]
    }
    return act
  }
}
