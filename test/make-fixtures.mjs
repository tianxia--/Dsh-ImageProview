// Generate one fixture per format the plugin claims to handle.
// PNG is hand-encoded; the rest come from sips (macOS) where available, plus
// hand-written TGA and Netpbm so the built-in decoders are always exercised.
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { encodePng } from '../lib/index.js'

const out = join(import.meta.dirname, 'fixtures')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const W = 64
const H = 40
const rgba = Buffer.alloc(W * H * 4)
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const at = (y * W + x) * 4
    rgba[at] = (x * 4) & 0xff
    rgba[at + 1] = (y * 6) & 0xff
    rgba[at + 2] = 0x80
    rgba[at + 3] = 0xff
  }
}
const png = join(out, 'base.png')
writeFileSync(png, encodePng(W, H, rgba))

// --- TGA: uncompressed 24-bit, bottom-left origin (the default convention)
const tgaHeader = Buffer.alloc(18)
tgaHeader[2] = 2
tgaHeader.writeUInt16LE(W, 12)
tgaHeader.writeUInt16LE(H, 14)
tgaHeader[16] = 24
const tgaPixels = Buffer.alloc(W * H * 3)
for (let index = 0; index < W * H; index += 1) {
  tgaPixels[index * 3] = 0x20
  tgaPixels[index * 3 + 1] = 0x60
  tgaPixels[index * 3 + 2] = 0xd0
}
writeFileSync(join(out, 'sample.tga'), Buffer.concat([tgaHeader, tgaPixels]))

// --- Netpbm P6, with the same gradient the other fixtures carry
const ppmPixels = Buffer.alloc(W * H * 3)
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const at = (y * W + x) * 3
    ppmPixels[at] = (x * 4) & 0xff
    ppmPixels[at + 1] = (y * 6) & 0xff
    ppmPixels[at + 2] = 0x80
  }
}
writeFileSync(join(out, 'sample.ppm'), Buffer.concat([Buffer.from('P6\n' + W + ' ' + H + '\n255\n', 'ascii'), ppmPixels]))

// --- SVG
writeFileSync(join(out, 'sample.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '"><rect width="100%" height="100%" fill="#1e88e5"/></svg>\n')

// --- a decoy: an allowed extension whose bytes are not an image at all
writeFileSync(join(out, 'decoy.png'), Buffer.from('#!/bin/sh\necho not an image\n', 'utf8'))

// --- sips conversions
const viaSips = [
  ['jpeg', 'sample.jpg'],
  ['tiff', 'sample.tiff'],
  ['bmp', 'sample.bmp'],
  ['gif', 'sample.gif'],
  ['heic', 'sample.heic'],
  ['jp2', 'sample.jp2'],
  ['psd', 'sample.psd'],
  ['png', 'sample-copy.png']
]
const produced = ['base.png', 'sample.tga', 'sample.ppm', 'sample.svg', 'decoy.png']
let sips = true
try { execFileSync('sips', ['--help'], { stdio: 'ignore' }) } catch { sips = false }
if (sips) {
  for (const [format, name] of viaSips) {
    try {
      execFileSync('sips', ['-s', 'format', format, png, '--out', join(out, name)], { stdio: 'ignore' })
      if (existsSync(join(out, name))) produced.push(name)
    } catch { /* this macOS build cannot write that format */ }
  }
}
console.log(JSON.stringify({ sips, produced }, null, 1))
