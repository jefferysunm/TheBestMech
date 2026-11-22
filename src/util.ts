export type V2 = [number, number]
export type V3 = [number, number, number]

export const TAU = Math.PI * 2

export function wrap(a: number): number {
  a = (a + Math.PI) % TAU
  if (a < 0) a += TAU
  return a - Math.PI
}
export function angDiff(a: number, b: number): number {
  return wrap(a - b)
}
export function dist2(ax: number, ay: number, bx: number, by: number) {
  return Math.hypot(bx - ax, by - ay)
}
export function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v
}
export function norm2(x: number, y: number): V2 {
  const l = Math.hypot(x, y)
  return l > 1e-9 ? [x / l, y / l] : [0, 0]
}

/** mulberry32 */
export class Rng {
  s: number
  constructor(seed: number) {
    this.s = (seed >>> 0) || 1
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  range(a: number, b: number) {
    return a + (b - a) * this.next()
  }
  gauss(): number {
    const u = Math.max(1e-12, this.next()), v = this.next()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v)
  }
}

/** zone circle at time tau given the zone observation */
export function zoneAt(z: { center: number[]; radius: number; next_center: number[]; next_radius: number; shrink_start: number; shrink_end: number }, tau: number) {
  if (tau <= z.shrink_start) return { x: z.center[0], y: z.center[1], r: z.radius }
  if (tau >= z.shrink_end || z.shrink_end <= z.shrink_start) return { x: z.next_center[0], y: z.next_center[1], r: z.next_radius }
  const f = (tau - z.shrink_start) / (z.shrink_end - z.shrink_start)
  return {
    x: z.center[0] + (z.next_center[0] - z.center[0]) * f,
    y: z.center[1] + (z.next_center[1] - z.center[1]) * f,
    r: z.radius + (z.next_radius - z.radius) * f,
  }
}
