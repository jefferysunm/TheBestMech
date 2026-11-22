import { World } from "../src/world.ts"
import { Nav } from "../src/nav.ts"
import { writePNG } from "./png.ts"
const w = new World("kit/arena")
const nav = new Nav(w)
const W = w.nx, H = w.ny
const rgb = new Uint8Array(W * H * 3)
for (let j = 0; j < H; j++)
  for (let i = 0; i < W; i++) {
    const c = j * W + i
    const row = H - 1 - j
    const o = (row * W + i) * 3
    const s = w.surf[c], t = w.terrain[c]
    if (w.wallDist[c] === 0) {
      const v = Math.min(255, 90 + (s - t) * 3)
      rgb[o] = v; rgb[o + 1] = v * 0.6; rgb[o + 2] = v * 0.4
    } else {
      const v = Math.max(0, Math.min(255, 110 + t * 4))
      rgb[o] = v * 0.5; rgb[o + 1] = v; rgb[o + 2] = v * 0.5
      if (s - t > 0.5) { rgb[o] = 80; rgb[o + 1] = 80; rgb[o + 2] = 220 } // bridge decks / low steps
    }
  }
// trees crowns
for (let t = 0; t < w.treeX.length; t++) {
  const i = Math.round(w.treeCX[t] - w.minX), j = Math.round(w.treeCY[t] - w.minY)
  if (i >= 0 && j >= 0 && i < W && j < H) { const o = ((H - 1 - j) * W + i) * 3; rgb[o] = 0; rgb[o + 1] = 90; rgb[o + 2] = 0 }
}
const paths = [[320, -280, -42, 7], [-400, 300, 400, -250], [-276, 128, 41, -72], [0, 0, 300, 200], [-450, -200, -300, 150]]
for (const [sx, sy, gx, gy] of paths) {
  const p = nav.plan(sx, sy, w.surface(sx, sy), gx, gy, {})
  if (!p) continue
  for (const q of p) {
    const i = Math.round(q[0] - w.minX), j = Math.round(q[1] - w.minY)
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const ii = i + a, jj = j + b
      if (ii < 0 || jj < 0 || ii >= W || jj >= H) continue
      const o = ((H - 1 - jj) * W + ii) * 3; rgb[o] = 255; rgb[o + 1] = 255; rgb[o + 2] = 0
    }
  }
}
writePNG(process.argv[2] ?? "map.png", W, H, rgb)
