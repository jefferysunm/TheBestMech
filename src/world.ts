/**
 * Static world model built from the map files (protocol.md section 11).
 *
 * - terrain: bilinear height field (1 m vertex grid)
 * - raster: every prism rasterized onto the same 1 m grid (cell (i,j) is centered on the terrain vertex),
 *   stored as a CSR list of prism ids per cell, plus the max prism top per cell for quick rejection
 * - surf: the 2.5D "standable surface" per raster cell: the terrain, or the top of the stack of solids a
 *   mech standing there would end up on (a prism whose underside is less than a mech height above the
 *   current surface is merged into it; anything higher, like a tall bridge, can be walked under)
 * - nav: a 2 m grid over surf for A*; walking edges where the climb is small, jet edges (cost by height)
 *   where it is a wall, free drops.
 */
import { readFileSync } from "node:fs"

export const KIND_BUILDING = 0
export const KIND_STADIUM = 1
export const KIND_BRIDGE = 2

export type Vec3 = [number, number, number]

export class World {
  // raster / terrain grid
  minX = 0
  minY = 0
  nx = 0
  ny = 0
  bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 }
  terrain!: Float32Array
  // prisms
  pBase!: Float32Array
  pTop!: Float32Array
  pKind!: Uint8Array
  cellStart!: Int32Array
  cellList!: Int32Array
  cellTop!: Float32Array
  // 2.5D surface
  surf!: Float32Array
  /** distance (m) from each raster cell to the nearest cell whose surface is a solid (building) surface */
  wallDist!: Float32Array
  // trees (vision only): flat arrays
  treeX!: Float32Array
  treeY!: Float32Array
  treeZ!: Float32Array
  treeH!: Float32Array
  treeCR!: Float32Array
  treeCB!: Float32Array
  treeTR!: Float32Array
  treeCX!: Float32Array
  treeCY!: Float32Array
  treeGridStart!: Int32Array
  treeGridList!: Int32Array
  treeGridN = 0
  treeGridNX = 0
  treeGridNY = 0
  canopyDensity = 0.35
  canopyBlockT = 0.25
  ok = false

  constructor(dir: string, mechHeight = 9, stepUp = 1.2) {
    const w = JSON.parse(readFileSync(`${dir}/v2/world.json`, "utf8"))
    const t = w.terrain
    this.minX = t.minX
    this.minY = t.minY
    this.nx = t.nx
    this.ny = t.ny
    const step = t.step ?? 1
    if (step !== 1) throw new Error("terrain step != 1 not supported")
    this.bounds = w.bounds
    const buf = readFileSync(`${dir}/v2/${t.file ?? "terrain.i16"}`)
    const n = this.nx * this.ny
    const scale = t.scale ?? 0.01
    const ter = new Float32Array(n)
    for (let k = 0; k < n; k++) ter[k] = buf.readInt16LE(k * 2) * scale
    this.terrain = ter
    if (w.rules) {
      this.canopyDensity = w.rules.canopyDensity ?? this.canopyDensity
      this.canopyBlockT = w.rules.canopyBlockT ?? this.canopyBlockT
    }
    this.buildPrisms(w.prisms)
    this.buildSurface(mechHeight, stepUp)
    this.buildTrees(w.trees)
    this.ok = true
  }

  private buildPrisms(prisms: any[]) {
    const np = prisms.length
    this.pBase = new Float32Array(np)
    this.pTop = new Float32Array(np)
    this.pKind = new Uint8Array(np)
    const nx = this.nx, ny = this.ny
    const counts = new Int32Array(nx * ny + 1)
    const cellsPer: Int32Array[] = []
    for (let p = 0; p < np; p++) {
      const pr = prisms[p]
      this.pBase[p] = pr.base
      this.pTop[p] = pr.top
      this.pKind[p] = pr.kind === "bridge" ? KIND_BRIDGE : pr.kind === "stadium" ? KIND_STADIUM : KIND_BUILDING
      const rings: number[][] = [pr.ring, ...(pr.holes ?? [])]
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
      for (let k = 0; k < pr.ring.length; k += 2) {
        const x = pr.ring[k], y = pr.ring[k + 1]
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
      const cells: number[] = []
      const j0 = Math.max(0, Math.ceil(y0 - this.minY - 0.5)), j1 = Math.min(ny - 1, Math.floor(y1 - this.minY + 0.5))
      const xs: number[] = []
      for (let j = j0; j <= j1; j++) {
        // sample 3 scanlines per row so thin walls are not lost; a cell is solid if any scanline covers it
        const marked = new Set<number>()
        for (const off of [-0.35, 0, 0.35]) {
          const y = this.minY + j + off
          xs.length = 0
          for (const r of rings) {
            const m = r.length
            for (let k = 0; k < m; k += 2) {
              const ax = r[k], ay = r[k + 1]
              const bx = r[(k + 2) % m], by = r[(k + 3) % m]
              if ((ay <= y && by > y) || (by <= y && ay > y)) xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax))
            }
          }
          xs.sort((a, b) => a - b)
          for (let k = 0; k + 1 < xs.length; k += 2) {
            // cells whose 1 m footprint overlaps [xs[k], xs[k+1]] by at least 0.3 m
            const ia = Math.max(0, Math.ceil(xs[k] - this.minX - 0.2)), ib = Math.min(nx - 1, Math.floor(xs[k + 1] - this.minX + 0.2))
            for (let i = ia; i <= ib; i++) marked.add(j * nx + i)
          }
        }
        for (const c of marked) cells.push(c)
      }
      const arr = Int32Array.from(cells)
      cellsPer.push(arr)
      for (const c of arr) counts[c + 1]++
    }
    for (let k = 0; k < nx * ny; k++) counts[k + 1] += counts[k]
    const list = new Int32Array(counts[nx * ny])
    const fill = counts.slice(0, nx * ny)
    for (let p = 0; p < np; p++) for (const c of cellsPer[p]) list[fill[c]++] = p
    this.cellStart = counts
    this.cellList = list
    const top = new Float32Array(nx * ny).fill(-1e9)
    for (let c = 0; c < nx * ny; c++) {
      for (let k = counts[c]; k < counts[c + 1]; k++) {
        const p = list[k]
        if (this.pTop[p] > top[c]) top[c] = this.pTop[p]
      }
    }
    this.cellTop = top
  }

  private buildSurface(mechHeight: number, stepUp: number) {
    const n = this.nx * this.ny
    const surf = new Float32Array(n)
    const solid = new Uint8Array(n)
    const idx: number[] = []
    for (let c = 0; c < n; c++) {
      let s = this.terrain[c]
      const a = this.cellStart[c], b = this.cellStart[c + 1]
      if (b > a) {
        idx.length = 0
        for (let k = a; k < b; k++) idx.push(this.cellList[k])
        idx.sort((p, q) => this.pBase[p] - this.pBase[q])
        for (const p of idx) {
          if (this.pTop[p] <= s) continue
          if (this.pBase[p] < s + mechHeight) {
            if (this.pTop[p] > s + stepUp * 0.5 && this.pKind[p] !== KIND_BRIDGE) solid[c] = 1
            s = this.pTop[p]
          }
        }
      }
      surf[c] = s
    }
    this.surf = surf
    // two-pass chamfer distance to solid (building/stadium) cells, in meters
    const nx = this.nx, ny = this.ny
    const d = new Float32Array(n)
    for (let c = 0; c < n; c++) d[c] = solid[c] ? 0 : 1e6
    const D1 = 1, D2 = Math.SQRT2
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i
        let v = d[c]
        if (i > 0) v = Math.min(v, d[c - 1] + D1)
        if (j > 0) {
          v = Math.min(v, d[c - nx] + D1)
          if (i > 0) v = Math.min(v, d[c - nx - 1] + D2)
          if (i < nx - 1) v = Math.min(v, d[c - nx + 1] + D2)
        }
        d[c] = v
      }
    for (let j = ny - 1; j >= 0; j--)
      for (let i = nx - 1; i >= 0; i--) {
        const c = j * nx + i
        let v = d[c]
        if (i < nx - 1) v = Math.min(v, d[c + 1] + D1)
        if (j < ny - 1) {
          v = Math.min(v, d[c + nx] + D1)
          if (i < nx - 1) v = Math.min(v, d[c + nx + 1] + D2)
          if (i > 0) v = Math.min(v, d[c + nx - 1] + D2)
        }
        d[c] = v
      }
    this.wallDist = d
  }

  private buildTrees(trees: any) {
    if (!trees || !trees.fields || !trees.data) {
      this.treeX = new Float32Array(0)
      this.treeGridStart = new Int32Array(1)
      this.treeGridList = new Int32Array(0)
      return
    }
    const f: string[] = trees.fields
    const nf = f.length
    const data: number[] = trees.data
    const nt = Math.floor(data.length / nf)
    const col = (name: string, dflt = 0) => {
      const k = f.indexOf(name)
      const a = new Float32Array(nt)
      for (let t = 0; t < nt; t++) a[t] = k >= 0 ? data[t * nf + k] : dflt
      return a
    }
    this.treeX = col("x")
    this.treeY = col("y")
    this.treeZ = col("z")
    this.treeH = col("height")
    this.treeCR = col("crownR")
    this.treeCB = col("crownBase")
    this.treeTR = col("trunkR", 0.5)
    this.treeCX = f.includes("crownX") ? col("crownX") : this.treeX
    this.treeCY = f.includes("crownY") ? col("crownY") : this.treeY
    // 16 m bucket grid
    const G = 16
    this.treeGridN = G
    this.treeGridNX = Math.ceil(this.nx / G) + 1
    this.treeGridNY = Math.ceil(this.ny / G) + 1
    const nb = this.treeGridNX * this.treeGridNY
    const buckets: number[][] = Array.from({ length: nb }, () => [])
    for (let t = 0; t < nt; t++) {
      const r = Math.max(this.treeCR[t], this.treeTR[t]) + 0.5
      const cx = this.treeCX[t], cy = this.treeCY[t]
      const bx0 = Math.floor((Math.min(cx, this.treeX[t]) - r - this.minX) / G), bx1 = Math.floor((Math.max(cx, this.treeX[t]) + r - this.minX) / G)
      const by0 = Math.floor((Math.min(cy, this.treeY[t]) - r - this.minY) / G), by1 = Math.floor((Math.max(cy, this.treeY[t]) + r - this.minY) / G)
      for (let by = Math.max(0, by0); by <= Math.min(this.treeGridNY - 1, by1); by++)
        for (let bx = Math.max(0, bx0); bx <= Math.min(this.treeGridNX - 1, bx1); bx++) buckets[by * this.treeGridNX + bx].push(t)
    }
    const start = new Int32Array(nb + 1)
    for (let b = 0; b < nb; b++) start[b + 1] = start[b] + buckets[b].length
    const list = new Int32Array(start[nb])
    for (let b = 0; b < nb; b++) list.set(buckets[b], start[b])
    this.treeGridStart = start
    this.treeGridList = list
  }

  // ------------------------------------------------------------------ queries
  inBounds(x: number, y: number, margin = 0) {
    const b = this.bounds
    return x >= b.minX + margin && x <= b.maxX - margin && y >= b.minY + margin && y <= b.maxY - margin
  }

  cellOf(x: number, y: number): number {
    let i = Math.round(x - this.minX), j = Math.round(y - this.minY)
    if (i < 0) i = 0
    else if (i >= this.nx) i = this.nx - 1
    if (j < 0) j = 0
    else if (j >= this.ny) j = this.ny - 1
    return j * this.nx + i
  }

  /** bilinear terrain height */
  ground(x: number, y: number): number {
    let fx = x - this.minX, fy = y - this.minY
    if (fx < 0) fx = 0
    if (fy < 0) fy = 0
    if (fx > this.nx - 1.001) fx = this.nx - 1.001
    if (fy > this.ny - 1.001) fy = this.ny - 1.001
    const i = Math.floor(fx), j = Math.floor(fy)
    const u = fx - i, v = fy - j
    const c = j * this.nx + i
    const t = this.terrain
    return (t[c] * (1 - u) + t[c + 1] * u) * (1 - v) + (t[c + this.nx] * (1 - u) + t[c + this.nx + 1] * u) * v
  }

  /** standable surface at (x,y) (2.5D model) */
  surface(x: number, y: number): number {
    const c = this.cellOf(x, y)
    const s = this.surf[c]
    const tc = this.terrain[c]
    if (s - tc < 0.01) return this.ground(x, y)
    return s
  }

  /** highest solid top at or below z+tol at (x,y): what a falling point at height z would land on */
  floorBelow(x: number, y: number, z: number, tol = 0.01): number {
    const c = this.cellOf(x, y)
    let f = this.ground(x, y)
    for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
      const p = this.cellList[k]
      const t = this.pTop[p]
      if (t <= z + tol && t > f) f = t
    }
    return f
  }

  /** is the point inside a prism or below terrain */
  solidAt(x: number, y: number, z: number): boolean {
    const c = this.cellOf(x, y)
    if (z < this.terrain[c] - 0.05) return true
    if (z >= this.cellTop[c]) return false
    for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
      const p = this.cellList[k]
      if (z >= this.pBase[p] && z < this.pTop[p]) return true
    }
    return false
  }

  /** lowest prism base above z in the cell (ceiling), or +inf */
  ceilingAbove(x: number, y: number, z: number): number {
    const c = this.cellOf(x, y)
    let best = Infinity
    for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
      const p = this.cellList[k]
      const b = this.pBase[p]
      if (b > z && b < best) best = b
    }
    return best
  }

  /** column (x,y) has a solid overlapping [z0, z1) */
  columnBlocked(x: number, y: number, z0: number, z1: number): boolean {
    const c = this.cellOf(x, y)
    if (z0 < this.terrain[c] - 0.05) return true
    if (z0 >= this.cellTop[c]) return false
    for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
      const p = this.cellList[k]
      if (this.pBase[p] < z1 && this.pTop[p] > z0) return true
    }
    return false
  }

  /**
   * Segment a->b against prisms and terrain (shots, sight). Returns the fraction t in [0,1] of the first
   * hit, or 1 if clear. DDA over the 1 m raster.
   */
  raycast(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const len2 = Math.hypot(dx, dy)
    const nx = this.nx
    // raster coordinates: cell i covers [i-0.5, i+0.5)
    const fx = ax - this.minX + 0.5, fy = ay - this.minY + 0.5
    let i = Math.floor(fx), j = Math.floor(fy)
    const stepI = dx > 0 ? 1 : -1, stepJ = dy > 0 ? 1 : -1
    const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity
    const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity
    let tMaxX = dx !== 0 ? (dx > 0 ? (i + 1 - fx) / dx : (fx - i) / -dx) : Infinity
    let tMaxY = dy !== 0 ? (dy > 0 ? (j + 1 - fy) / dy : (fy - j) / -dy) : Infinity
    let t0 = 0
    const maxSteps = Math.ceil(Math.abs(dx)) + Math.ceil(Math.abs(dy)) + 3
    for (let s = 0; s < maxSteps; s++) {
      const t1 = Math.min(tMaxX, tMaxY, 1)
      if (i < 0 || j < 0 || i >= nx || j >= this.ny) return t0
      const c = j * nx + i
      const za = az + dz * t0, zb = az + dz * t1
      const zlo = za < zb ? za : zb, zhi = za < zb ? zb : za
      // terrain: compare with the vertex height (cells are vertex-centred)
      if (zlo < this.terrain[c] - 0.3 && len2 > 0) {
        // refine with bilinear at the low end
        const tt = za < zb ? t0 : t1
        const g = this.ground(ax + dx * tt, ay + dy * tt)
        if (zlo < g) return t0
      }
      if (zlo < this.cellTop[c]) {
        for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
          const p = this.cellList[k]
          if (zlo < this.pTop[p] && zhi > this.pBase[p]) return t0
        }
      }
      if (t1 >= 1) return 1
      t0 = t1
      if (tMaxX < tMaxY) {
        tMaxX += tDeltaX
        i += stepI
      } else {
        tMaxY += tDeltaY
        j += stepJ
      }
    }
    return 1
  }

  clear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    return this.raycast(ax, ay, az, bx, by, bz) >= 1
  }

  /** metres of tree crown a segment passes through (Infinity if a trunk blocks it) */
  canopy(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
    if (this.treeX.length === 0) return 0
    const G = this.treeGridN
    const dx = bx - ax, dy = by - ay, dz = bz - az
    const L = Math.hypot(dx, dy)
    if (L < 1e-6) return 0
    const bx0 = Math.max(0, Math.floor((Math.min(ax, bx) - this.minX) / G)), bx1 = Math.min(this.treeGridNX - 1, Math.floor((Math.max(ax, bx) - this.minX) / G))
    const by0 = Math.max(0, Math.floor((Math.min(ay, by) - this.minY) / G)), by1 = Math.min(this.treeGridNY - 1, Math.floor((Math.max(ay, by) - this.minY) / G))
    let opacity = 0
    const seen = new Set<number>()
    for (let gy = by0; gy <= by1; gy++)
      for (let gx = bx0; gx <= bx1; gx++) {
        // skip buckets far from the segment
        const cxB = this.minX + (gx + 0.5) * G, cyB = this.minY + (gy + 0.5) * G
        const tB = Math.max(0, Math.min(1, ((cxB - ax) * dx + (cyB - ay) * dy) / (L * L)))
        if (Math.hypot(ax + dx * tB - cxB, ay + dy * tB - cyB) > G * 0.75 + 12) continue
        const b = gy * this.treeGridNX + gx
        for (let k = this.treeGridStart[b]; k < this.treeGridStart[b + 1]; k++) {
          const tr = this.treeGridList[k]
          if (seen.has(tr)) continue
          seen.add(tr)
          // trunk: vertical cylinder from z to crownBase (+z)
          const tx = this.treeX[tr], ty = this.treeY[tr]
          let tt = ((tx - ax) * dx + (ty - ay) * dy) / (L * L)
          if (tt > 0.02 && tt < 0.98) {
            const d = Math.hypot(ax + dx * tt - tx, ay + dy * tt - ty)
            const zz = az + dz * tt
            if (d < this.treeTR[tr] && zz < this.treeZ[tr] + this.treeCB[tr] && zz > this.treeZ[tr]) return Infinity
          }
          // crown: sphere-ish ellipsoid; use chord length through a cylinder from crownBase to height
          const cx = this.treeCX[tr], cy = this.treeCY[tr], r = this.treeCR[tr]
          if (r <= 0) continue
          tt = ((cx - ax) * dx + (cy - ay) * dy) / (L * L)
          const dd = Math.hypot(ax + dx * tt - cx, ay + dy * tt - cy)
          if (dd >= r) continue
          const half = Math.sqrt(r * r - dd * dd) / L
          const ta = Math.max(0, tt - half), tb = Math.min(1, tt + half)
          if (tb <= ta) continue
          const zlo = this.treeZ[tr] + this.treeCB[tr], zhi = this.treeZ[tr] + this.treeH[tr]
          // portion of [ta,tb] where the ray z is inside [zlo,zhi]
          let ua = ta, ub = tb
          if (Math.abs(dz) > 1e-6) {
            const t1 = (zlo - az) / dz, t2 = (zhi - az) / dz
            ua = Math.max(ua, Math.min(t1, t2))
            ub = Math.min(ub, Math.max(t1, t2))
          } else if (az < zlo || az > zhi) continue
          if (ub <= ua) continue
          opacity += (ub - ua) * Math.hypot(L, dz)
        }
      }
    return opacity
  }

  /** does foliage block sight along the segment (transmittance exp(-density*len) below blockT) */
  canopyBlocks(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const len = this.canopy(ax, ay, az, bx, by, bz)
    return Math.exp(-this.canopyDensity * len) < this.canopyBlockT
  }
}

export function loadWorld(dir: string, mechHeight = 9, stepUp = 1.2): World | null {
  try {
    return new World(dir, mechHeight, stepUp)
  } catch (e) {
    console.error("world load failed:", e)
    return null
  }
}
