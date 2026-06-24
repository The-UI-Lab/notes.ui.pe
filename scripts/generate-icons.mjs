/**
 * Generate raster PWA icons from the app's vector logo — no dependencies.
 *
 * iOS does not support SVG app icons, and Android benefits from a dedicated
 * `maskable` icon, so we rasterize `public/icon.svg` into PNGs here. The logo
 * is pure geometry (rounded rects + one polygon), so this renders the shapes
 * directly onto an RGBA buffer (with supersampling for smooth edges) and
 * encodes a PNG using Node's built-in `zlib` — keeping the build dependency-free.
 *
 * Run: `node scripts/generate-icons.mjs`
 * Outputs: public/icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon.png
 *
 * Shapes mirror public/icon.svg — keep them in sync if the SVG changes.
 */

import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
const VIEWBOX = 512 // SVG coordinate space
const SS = 4 // supersampling factor

// ── Logo shapes (in 0..512 SVG user units), painter order back→front ────────
const TERRACOTTA = [0x8a, 0x32, 0x18]
const PAPER = [0xf5, 0xed, 0xe3]
const ACCENT = [0xc4, 0x5c, 0x32]

const SHAPES = [
  { kind: 'rrect', x: 0, y: 0, w: 512, h: 512, rx: 112, fill: TERRACOTTA, alpha: 1 },
  { kind: 'rrect', x: 118, y: 96, w: 260, h: 320, rx: 22, fill: PAPER, alpha: 0.96 },
  { kind: 'rrect', x: 158, y: 172, w: 180, h: 11, rx: 5.5, fill: TERRACOTTA, alpha: 0.3 },
  { kind: 'rrect', x: 158, y: 206, w: 196, h: 11, rx: 5.5, fill: TERRACOTTA, alpha: 0.3 },
  { kind: 'rrect', x: 158, y: 240, w: 164, h: 11, rx: 5.5, fill: TERRACOTTA, alpha: 0.3 },
  { kind: 'rrect', x: 158, y: 274, w: 188, h: 11, rx: 5.5, fill: TERRACOTTA, alpha: 0.3 },
  { kind: 'rrect', x: 158, y: 308, w: 148, h: 11, rx: 5.5, fill: TERRACOTTA, alpha: 0.3 },
  { kind: 'rrect', x: 296, y: 88, w: 36, h: 120, rx: 10, fill: PAPER, alpha: 1, rot: { deg: 42, cx: 296, cy: 88 } },
  { kind: 'poly', pts: [[368, 118], [350, 148], [380, 152]], fill: PAPER, alpha: 0.85 },
  { kind: 'rrect', x: 296, y: 88, w: 36, h: 28, rx: 10, fill: ACCENT, alpha: 1, rot: { deg: 42, cx: 296, cy: 88 } },
]

// ── Point-in-shape tests (coordinates in SVG user units) ────────────────────

function insideRoundedRect(px, py, s) {
  const { x, y, w, h, rx } = s
  if (px < x || px > x + w || py < y || py > y + h) return false
  const r = Math.min(rx, w / 2, h / 2)
  // Corner regions: only the rounded part is excluded.
  const cx = px < x + r ? x + r : px > x + w - r ? x + w - r : px
  const cy = py < y + r ? y + r : py > y + h - r ? y + h - r : py
  const dx = px - cx
  const dy = py - cy
  return dx * dx + dy * dy <= r * r
}

function insideRect(px, py, s) {
  if (s.rot) {
    // Inverse-rotate the sample point around the pivot, then test unrotated.
    const a = (-s.rot.deg * Math.PI) / 180
    const ox = px - s.rot.cx
    const oy = py - s.rot.cy
    const rx = ox * Math.cos(a) - oy * Math.sin(a) + s.rot.cx
    const ry = ox * Math.sin(a) + oy * Math.cos(a) + s.rot.cy
    return insideRoundedRect(rx, ry, s)
  }
  return insideRoundedRect(px, py, s)
}

function insidePolygon(px, py, pts) {
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]
    const [xj, yj] = pts[j]
    const intersect = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function hit(px, py, s) {
  return s.kind === 'poly' ? insidePolygon(px, py, s.pts) : insideRect(px, py, s)
}

// ── Render one icon at `size` px, optional `padScale` for maskable safe-zone ─
function renderRGBA(size, padScale = 1) {
  const dim = size * SS
  const buf = new Uint8ClampedArray(dim * dim * 4) // transparent
  const scale = (dim / VIEWBOX) * padScale
  const offset = (dim - VIEWBOX * scale) / 2 // center after padding

  for (let py = 0; py < dim; py++) {
    for (let px = 0; px < dim; px++) {
      // Map device pixel center → SVG user coordinates.
      const ux = (px + 0.5 - offset) / scale
      const uy = (py + 0.5 - offset) / scale
      let r = 0, g = 0, b = 0, a = 0
      for (const s of SHAPES) {
        if (!hit(ux, uy, s)) continue
        const sa = s.alpha
        // Source-over compositing.
        const na = sa + a * (1 - sa)
        if (na <= 0) continue
        r = (s.fill[0] * sa + r * a * (1 - sa)) / na
        g = (s.fill[1] * sa + g * a * (1 - sa)) / na
        b = (s.fill[2] * sa + b * a * (1 - sa)) / na
        a = na
      }
      const i = (py * dim + px) * 4
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = Math.round(a * 255)
    }
  }

  // Box-downsample SS×SS → final size.
  const out = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * dim + (x * SS + sx)) * 4
          const pa = buf[i + 3]
          r += buf[i] * pa; g += buf[i + 1] * pa; b += buf[i + 2] * pa; a += pa
        }
      }
      const o = (y * size + x) * 4
      out[o] = a ? r / a : 0
      out[o + 1] = a ? g / a : 0
      out[o + 2] = a ? b / a : 0
      out[o + 3] = a / (SS * SS)
    }
  }
  return out
}

// ── Minimal PNG encoder (RGBA, 8-bit) ───────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  // 10,11,12 = compression/filter/interlace = 0

  // Add a per-row filter byte (0 = none).
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── Emit ─────────────────────────────────────────────────────────────────────

const targets = [
  { file: 'icon-192.png', size: 192, pad: 1 },
  { file: 'icon-512.png', size: 512, pad: 1 },
  // Maskable: shrink the artwork into the ~80% safe zone (background still
  // full-bleed terracotta, so the padding is invisible but the page/pen stay
  // clear of the platform's circular/squircle mask).
  { file: 'icon-maskable-512.png', size: 512, pad: 0.82 },
  { file: 'apple-touch-icon.png', size: 180, pad: 1 },
]

for (const t of targets) {
  const rgba = renderRGBA(t.size, t.pad)
  const png = encodePNG(rgba, t.size)
  writeFileSync(join(OUT_DIR, t.file), png)
  console.log(`wrote public/${t.file} (${t.size}x${t.size}, ${png.length} bytes)`)
}
