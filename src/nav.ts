/**
 * 2 m navigation grid over the world's 2.5D surface, with A*.
 *
 * Node (I,J) covers raster cells i in {2I,2I+1}, j in {2J,2J+1}; its height is the max surface of those cells.
 * Edges go to the 8 neighbours. Walking edges climb little; "hop" edges (a jump clears them) cost a bit more;
 * "jet" edges (a wall or roof edge) cost distance plus a multiple of the climb and are only allowed up to
 * maxClimb. Drops are free. Ground nodes hugging a wall cost extra so paths keep the mech's 2.5 m radius clear.
 */
import type { World } from "./world.ts"

export const NAV_STEP = 2

export type Circle = { x: number; y: number; r: number }

export type PlanOpts = {
  maxClimb?: number // highest climb (m) a single edge may need
  climbCost?: number // extra cost per metre of jet climb
  zone?: Circle | null // nodes outside cost extra
  zonePenalty?: number // extra cost per metre walked outside the zone
  avoid?: { x: number; y: number; r: number; cost: number }[] // soft danger discs
  maxExpand?: number
  roofCost?: number // extra cost per metre walked on a roof (solid surface)
}

export class Nav {
  NX: number
  NY: number
  h: Float32Array // node height
  clear: Float32Array // wall clearance (m) for ground nodes, 0 for roof nodes
  roof: Uint8Array // 1 if node is on a solid (building) surface
  blocked: Uint8Array // 1 = never enter (map edge)
  private g: Float32Array
  private came: Int32Array
  private stamp: Int32Array
  private closed: Int32Array
  private search = 0
  private heapN: Int32Array
  private heapF: Float32Array
  lastExpanded = 0
  /** did the last plan() reach its goal (false = partial path toward it) */
  lastReached = false

  constructor(public w: World) {
    const NX = Math.ceil(w.nx / NAV_STEP), NY = Math.ceil(w.ny / NAV_STEP)
    this.NX = NX
    this.NY = NY
    const N = NX * NY
    this.h = new Float32Array(N)
    this.clear = new Float32Array(N)
    this.roof = new Uint8Array(N)
    this.blocked = new Uint8Array(N)
    for (let J = 0; J < NY; J++)
      for (let I = 0; I < NX; I++) {
        const n = J * NX + I
        let hmax = -1e9, cmin = 1e9
        for (let dj = 0; dj < 2; dj++)
          for (let di = 0; di < 2; di++) {
            const i = Math.min(w.nx - 1, 2 * I + di), j = Math.min(w.ny - 1, 2 * J + dj)
            const c = j * w.nx + i
            if (w.surf[c] > hmax) hmax = w.surf[c]
            if (w.wallDist[c] < cmin) cmin = w.wallDist[c]
          }
        this.h[n] = hmax
        this.clear[n] = cmin
        this.roof[n] = cmin < 0.5 ? 1 : 0
        const x = this.nodeX(n), y = this.nodeY(n)
        if (!w.inBounds(x, y, 3)) this.blocked[n] = 1
      }
    this.g = new Float32Array(N)
    this.came = new Int32Array(N)
    this.stamp = new Int32Array(N)
    this.closed = new Int32Array(N)
    this.heapN = new Int32Array(1 << 16)
    this.heapF = new Float32Array(1 << 16)
  }

  nodeX(n: number) {
    return this.w.minX + (n % this.NX) * NAV_STEP + 0.5
  }
  nodeY(n: number) {
    return this.w.minY + Math.floor(n / this.NX) * NAV_STEP + 0.5
  }
  nodeAt(x: number, y: number): number {
    let I = Math.floor((x - this.w.minX + 0.5) / NAV_STEP), J = Math.floor((y - this.w.minY + 0.5) / NAV_STEP)
    if (I < 0) I = 0
    else if (I >= this.NX) I = this.NX - 1
    if (J < 0) J = 0
    else if (J >= this.NY) J = this.NY - 1
    return J * this.NX + I
  }

  /** nearest node (spiral) that is not blocked and whose height is within maxDz of z (if given) */
  nearestFree(x: number, y: number, z?: number, maxR = 20): number {
    const n0 = this.nodeAt(x, y)
    const ok = (n: number) => !this.blocked[n] && (z === undefined || Math.abs(this.h[n] - z) < 3) && (this.roof[n] || this.clear[n] >= 3)
    if (ok(n0)) return n0
    const I0 = n0 % this.NX, J0 = Math.floor(n0 / this.NX)
    for (let r = 1; r <= maxR; r++) {
      let best = -1, bd = 1e9
      for (let dJ = -r; dJ <= r; dJ++)
        for (let dI = -r; dI <= r; dI++) {
          if (Math.max(Math.abs(dI), Math.abs(dJ)) !== r) continue
          const I = I0 + dI, J = J0 + dJ
          if (I < 0 || J < 0 || I >= this.NX || J >= this.NY) continue
          const n = J * this.NX + I
          if (!ok(n)) continue
          const d = dI * dI + dJ * dJ
          if (d < bd) {
            bd = d
            best = n
          }
        }
      if (best >= 0) return best
    }
    return n0
  }

  private push(n: number, f: number, size: number): number {
    if (size >= this.heapN.length) {
      const nn = new Int32Array(this.heapN.length * 2)
      nn.set(this.heapN)
      this.heapN = nn
      const nf = new Float32Array(this.heapF.length * 2)
      nf.set(this.heapF)
      this.heapF = nf
    }
    const H = this.heapN, F = this.heapF
    let k = size
    while (k > 0) {
      const p = (k - 1) >> 1
      if (F[p] <= f) break
      H[k] = H[p]
      F[k] = F[p]
      k = p
    }
    H[k] = n
    F[k] = f
    return size + 1
  }

  private pop(size: number): number {
    const H = this.heapN, F = this.heapF
    const top = H[0]
    size--
    const ln = H[size], lf = F[size]
    let k = 0
    for (;;) {
      let c = 2 * k + 1
      if (c >= size) break
      if (c + 1 < size && F[c + 1] < F[c]) c++
      if (F[c] >= lf) break
      H[k] = H[c]
      F[k] = F[c]
      k = c
    }
    H[k] = ln
    F[k] = lf
    return top
  }

  /** cost of a single directed edge, or -1 if not allowed */
  edgeCost(a: number, b: number, len: number, o: PlanOpts): number {
    if (this.blocked[b]) return -1
    const climb = this.h[b] - this.h[a]
    let cost = len
    const maxClimb = o.maxClimb ?? 40
    if (climb > 1.3 * (len / NAV_STEP)) {
      if (climb > maxClimb) return -1
      if (climb > 2.4) cost += (o.climbCost ?? 2.5) * climb + 4
      else cost += 1.5
    }
    if (!this.roof[b]) {
      const c = this.clear[b]
      if (c < 3.5) cost += (3.5 - c) * 1.5 * len
    } else if (o.roofCost) cost += o.roofCost * len
    if (o.zone) {
      const dx = this.nodeX(b) - o.zone.x, dy = this.nodeY(b) - o.zone.y
      const d = Math.hypot(dx, dy)
      if (d > o.zone.r) cost += (o.zonePenalty ?? 3) * len * (1 + (d - o.zone.r) / 50)
    }
    if (o.avoid) {
      const x = this.nodeX(b), y = this.nodeY(b)
      for (const a2 of o.avoid) {
        const d = Math.hypot(x - a2.x, y - a2.y)
        if (d < a2.r) cost += a2.cost * len * (1 - d / a2.r)
      }
    }
    return cost
  }

  /**
   * A* from (sx,sy) to (gx,gy). Returns world waypoints [x,y,h][] (start excluded), or null.
   * If the expansion budget runs out, returns the path to the node closest to the goal.
   */
  plan(sx: number, sy: number, sz: number, gx: number, gy: number, o: PlanOpts = {}): [number, number, number][] | null {
    const start = this.nearestFree(sx, sy, sz, 6)
    const goal = this.nearestFree(gx, gy, undefined, 25)
    this.lastReached = true
    if (start === goal) return [[this.nodeX(goal), this.nodeY(goal), this.h[goal]]]
    const NX = this.NX, NY = this.NY
    this.search++
    const S = this.search
    const g = this.g, came = this.came, stamp = this.stamp, closed = this.closed
    const gxN = this.nodeX(goal), gyN = this.nodeY(goal)
    const hfun = (n: number) => {
      const dx = Math.abs(this.nodeX(n) - gxN), dy = Math.abs(this.nodeY(n) - gyN)
      return dx > dy ? dx + 0.4142 * dy : dy + 0.4142 * dx
    }
    g[start] = 0
    stamp[start] = S
    came[start] = -1
    let size = this.push(start, hfun(start), 0)
    const maxExpand = o.maxExpand ?? 120000
    let expanded = 0
    let best = start, bestH = hfun(start)
    const D = NAV_STEP, DD = NAV_STEP * Math.SQRT2
    const dI = [1, -1, 0, 0, 1, 1, -1, -1]
    const dJ = [0, 0, 1, -1, 1, -1, 1, -1]
    let found = false
    while (size > 0) {
      const n = this.pop(size)
      size--
      if (closed[n] === S) continue
      closed[n] = S
      if (n === goal) {
        found = true
        break
      }
      const hn = hfun(n)
      if (hn < bestH) {
        bestH = hn
        best = n
      }
      if (++expanded > maxExpand) break
      const I = n % NX, J = (n - I) / NX
      const gn = g[n]
      for (let k = 0; k < 8; k++) {
        const I2 = I + dI[k], J2 = J + dJ[k]
        if (I2 < 0 || J2 < 0 || I2 >= NX || J2 >= NY) continue
        const m = J2 * NX + I2
        if (closed[m] === S) continue
        const len = k < 4 ? D : DD
        if (k >= 4) {
          // no corner cutting through blocked / much higher nodes
          const ma = J * NX + I2, mb = J2 * NX + I
          if (this.blocked[ma] || this.blocked[mb]) continue
          if (this.h[ma] - this.h[n] > 2.4 || this.h[mb] - this.h[n] > 2.4) continue
        }
        const c = this.edgeCost(n, m, len, o)
        if (c < 0) continue
        const ng = gn + c
        if (stamp[m] !== S || ng < g[m]) {
          stamp[m] = S
          g[m] = ng
          came[m] = n
          size = this.push(m, ng + hfun(m), size)
        }
      }
    }
    this.lastExpanded = expanded
    this.lastReached = found
    const end = found ? goal : best
    if (end === start) return null
    const out: [number, number, number][] = []
    let n = end
    let guard = 0
    while (n !== start && n >= 0 && guard++ < 100000) {
      out.push([this.nodeX(n), this.nodeY(n), this.h[n]])
      n = came[n]
    }
    out.reverse()
    return out
  }

  /**
   * Can a mech walk straight from a to b on the surface (no climbs above a hop, enough wall clearance)?
   * Samples every metre.
   */
  walkable(ax: number, ay: number, az: number, bx: number, by: number, maxStep = 1.1, minClear = 2.8): boolean {
    const L = Math.hypot(bx - ax, by - ay)
    const steps = Math.max(1, Math.ceil(L / 1.0))
    let prevH = az
    for (let s = 1; s <= steps; s++) {
      const t = s / steps
      const x = ax + (bx - ax) * t, y = ay + (by - ay) * t
      const n = this.nodeAt(x, y)
      if (this.blocked[n]) return false
      const hh = this.w.surface(x, y)
      if (hh - prevH > maxStep) return false
      if (!this.roof[n] && this.w.wallDist[this.w.cellOf(x, y)] < minClear) return false
      prevH = hh
    }
    return true
  }
}
