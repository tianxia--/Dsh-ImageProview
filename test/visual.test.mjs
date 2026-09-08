// Does a transcode actually preserve the picture?
//
// The route tests only prove "a PNG of the right size came back", which a
// black rectangle would also satisfy. This suite decodes every served payload
// back to pixels, compares it against the source (including deliberately
// wrong orientations and channel orders, the two failures a hand-written
// decoder makes), and tiles everything into one contact sheet for a human.
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { apply, encodePng, sniffFormat } from '../lib/index.js'

const out = join(import.meta.dirname, 'served')
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const W = 160
const H = 100

/**
 * A source pattern built to expose the classic transcode faults: pure R/G/B
 * bands catch a channel swap, top-vs-bottom asymmetry catches a vertical
 * flip, the diagonal catches a stride error, and the checker catches
 * subsampling damage.
 */
function sourcePixels() {
  const rgba = Buffer.alloc(W * H * 4, 255)
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const at = (y * W + x) * 4
      let r = 0
      let g = 0
      let b = 0
      const band = Math.floor((y * 4) / H)
      if (band === 0) { r = 255 }
      else if (band === 1) { g = 255 }
      else if (band === 2) { b = 255 }
      else { r = 255; g = 255; b = 0 }
      if (x < 40 && y > H - 30 && ((Math.floor(x / 5) + Math.floor(y / 5)) % 2 === 0)) { r = 0; g = 0; b = 0 }
      if (Math.abs((x * H) / W - y) < 4) { r = 255; g = 255; b = 255 }
      rgba[at] = r
      rgba[at + 1] = g
      rgba[at + 2] = b
      rgba[at + 3] = 255
    }
  }
  return rgba
}

//#region a minimal PNG reader, enough for what the transcoders emit
function decodePng(bytes) {
  if (sniffFormat(bytes) !== 'png') throw new Error('not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  let depth = 0
  let colorType = 0
  let interlace = 0
  const idat = []
  let palette
  let alphaPalette
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii')
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') palette = Buffer.from(data)
    else if (type === 'tRNS') alphaPalette = Buffer.from(data)
    else if (type === 'IDAT') idat.push(Buffer.from(data))
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (depth !== 8) throw new Error('unsupported bit depth ' + String(depth))
  if (interlace !== 0) throw new Error('interlaced PNG not supported')
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const rgba = Buffer.alloc(width * height * 4, 255)
  const line = Buffer.alloc(stride)
  const previous = Buffer.alloc(stride)
  let cursor = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor]
    cursor += 1
    raw.copy(line, 0, cursor, cursor + stride)
    cursor += stride
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? line[index - channels] : 0
      const up = previous[index]
      const upLeft = index >= channels ? previous[index - channels] : 0
      if (filter === 1) line[index] = (line[index] + left) & 0xff
      else if (filter === 2) line[index] = (line[index] + up) & 0xff
      else if (filter === 3) line[index] = (line[index] + ((left + up) >> 1)) & 0xff
      else if (filter === 4) {
        const p = left + up - upLeft
        const dLeft = Math.abs(p - left)
        const dUp = Math.abs(p - up)
        const dUpLeft = Math.abs(p - upLeft)
        const predictor = dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft
        line[index] = (line[index] + predictor) & 0xff
      }
    }
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4
      const source = x * channels
      if (colorType === 0) { rgba[target] = rgba[target + 1] = rgba[target + 2] = line[source] }
      else if (colorType === 2) { rgba[target] = line[source]; rgba[target + 1] = line[source + 1]; rgba[target + 2] = line[source + 2] }
      else if (colorType === 3) {
        const entry = line[source] * 3
        rgba[target] = palette[entry]
        rgba[target + 1] = palette[entry + 1]
        rgba[target + 2] = palette[entry + 2]
        if (alphaPalette !== undefined && line[source] < alphaPalette.length) rgba[target + 3] = alphaPalette[line[source]]
      } else if (colorType === 4) { rgba[target] = rgba[target + 1] = rgba[target + 2] = line[source]; rgba[target + 3] = line[source + 1] }
      else { rgba[target] = line[source]; rgba[target + 1] = line[source + 1]; rgba[target + 2] = line[source + 2]; rgba[target + 3] = line[source + 3] }
    }
    line.copy(previous)
  }
  return { width, height, rgba }
}
//#endregion

/** Mean absolute error over RGB, ignoring alpha. */
function meanError(left, right) {
  let total = 0
  for (let index = 0; index < left.length; index += 4) {
    total += Math.abs(left[index] - right[index]) + Math.abs(left[index + 1] - right[index + 1]) + Math.abs(left[index + 2] - right[index + 2])
  }
  return total / ((left.length / 4) * 3)
}

function flipVertical(rgba, width, height) {
  const stride = width * 4
  const flipped = Buffer.alloc(rgba.length)
  for (let y = 0; y < height; y += 1) rgba.copy(flipped, (height - 1 - y) * stride, y * stride, y * stride + stride)
  return flipped
}

function swapRedBlue(rgba) {
  const swapped = Buffer.from(rgba)
  for (let index = 0; index < swapped.length; index += 4) {
    const red = swapped[index]
    swapped[index] = swapped[index + 2]
    swapped[index + 2] = red
  }
  return swapped
}

/** Nearest-neighbour tile for the contact sheet. */
function scaleInto(sheet, sheetWidth, source, sourceWidth, sourceHeight, left, top, tileWidth, tileHeight) {
  for (let y = 0; y < tileHeight; y += 1) {
    for (let x = 0; x < tileWidth; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor((x * sourceWidth) / tileWidth))
      const sourceY = Math.min(sourceHeight - 1, Math.floor((y * sourceHeight) / tileHeight))
      const from = (sourceY * sourceWidth + sourceX) * 4
      const to = ((top + y) * sheetWidth + left + x) * 4
      sheet[to] = source[from]
      sheet[to + 1] = source[from + 1]
      sheet[to + 2] = source[from + 2]
      sheet[to + 3] = 255
    }
  }
}

// --- build the source and every format from it
const source = sourcePixels()
const sourcePng = join(out, 'source.png')
writeFileSync(sourcePng, encodePng(W, H, source))

const targets = [['png', 'copy.png'], ['jpeg', 'photo.jpg'], ['gif', 'anim.gif'], ['bmp', 'bitmap.bmp'], ['tiff', 'scan.tiff'], ['heic', 'phone.heic'], ['jp2', 'wave.jp2'], ['psd', 'layered.psd'], ['dds', 'texture.dds'], ['exr', 'render.exr']]
const made = [['source.png', 'png']]
const skipped = []
for (const [format, name] of targets) {
  try {
    execFileSync('sips', ['-s', 'format', format, sourcePng, '--out', join(out, name)], { stdio: 'ignore' })
    // sips advertises some formats as writable and then emits a zero-byte
    // file (DDS on this build). A fixture that could not be produced is a
    // gap in the local toolchain, not a plugin failure, so it is skipped
    // loudly instead of asserted.
    if (statSync(join(out, name)).size === 0) throw new Error('zero-byte output')
    made.push([name, format])
  } catch (error) {
    skipped.push(format + ' (' + (error?.message ?? 'unsupported') + ')')
  }
}
// TGA, 24-bit uncompressed, bottom-left origin: the flip and BGR order are
// exactly what the built-in decoder has to get right.
const tgaHeader = Buffer.alloc(18)
tgaHeader[2] = 2
tgaHeader.writeUInt16LE(W, 12)
tgaHeader.writeUInt16LE(H, 14)
tgaHeader[16] = 24
const tgaBody = Buffer.alloc(W * H * 3)
for (let y = 0; y < H; y += 1) {
  for (let x = 0; x < W; x += 1) {
    const from = ((H - 1 - y) * W + x) * 4
    const to = (y * W + x) * 3
    tgaBody[to] = source[from + 2]
    tgaBody[to + 1] = source[from + 1]
    tgaBody[to + 2] = source[from]
  }
}
writeFileSync(join(out, 'art.tga'), Buffer.concat([tgaHeader, tgaBody]))
made.push(['art.tga', 'tga'])
const ppmBody = Buffer.alloc(W * H * 3)
for (let index = 0; index < W * H; index += 1) {
  ppmBody[index * 3] = source[index * 4]
  ppmBody[index * 3 + 1] = source[index * 4 + 1]
  ppmBody[index * 3 + 2] = source[index * 4 + 2]
}
writeFileSync(join(out, 'plot.ppm'), Buffer.concat([Buffer.from('P6\n' + String(W) + ' ' + String(H) + '\n255\n', 'ascii'), ppmBody]))
made.push(['plot.ppm', 'pnm'])

// --- serve every one of them through the plugin's real route
const routes = new Map()
apply({ inject: (_services, run) => run({ webServer: { register: (route) => routes.set(route.path, route) }, get: () => undefined }) }, { allowRoots: [out] })
const server = createServer((req, res) => {
  const route = routes.get(new URL(req.url, 'http://localhost').pathname)
  if (route === undefined) { res.writeHead(404).end(); return }
  Promise.resolve(route.handler(req, res)).catch(() => res.writeHead(500).end())
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + String(server.address().port)

const results = []
for (const [name, format] of made) {
  const metaResponse = await fetch(base + '/image-preview/meta?path=' + encodeURIComponent(join(out, name)))
  const meta = await metaResponse.json()
  if (meta.ok !== true) { results.push({ name, format, error: meta.reason }); continue }
  const fileResponse = await fetch(base + '/image-preview/file?path=' + encodeURIComponent(join(out, name)) + '&v=' + meta.version)
  const served = Buffer.from(await fileResponse.arrayBuffer())
  const servedPath = join(out, 'served-' + name.replace(/\./g, '_') + (meta.transcoded === true ? '.png' : '.' + name.split('.').pop()))
  writeFileSync(servedPath, served)
  // Decode what the browser would receive. A payload the browser renders
  // natively but this decoder cannot read (JPEG, GIF, BMP) is converted with
  // sips FOR MEASUREMENT ONLY - the bytes the route served are untouched.
  let decoded
  if (sniffFormat(served) === 'png') decoded = decodePng(served)
  else {
    const asPng = servedPath + '.probe.png'
    execFileSync('sips', ['-s', 'format', 'png', servedPath, '--out', asPng], { stdio: 'ignore' })
    decoded = decodePng(readFileSync(asPng))
  }
  const straight = meanError(source, decoded.rgba)
  const flipped = meanError(flipVertical(source, W, H), decoded.rgba)
  const swapped = meanError(swapRedBlue(source), decoded.rgba)
  results.push({
    name,
    format,
    mediaType: meta.mediaType,
    transcoded: meta.transcoded,
    via: meta.via,
    dimensions: decoded.width + 'x' + decoded.height,
    mae: Number(straight.toFixed(2)),
    maeFlipped: Number(flipped.toFixed(2)),
    maeSwapped: Number(swapped.toFixed(2)),
    pixels: decoded.rgba
  })
}
server.close()

// --- contact sheet: source first, then every served payload
const columns = 4
const tileWidth = 160
const tileHeight = 100
const gap = 6
const rows = Math.ceil(results.length / columns)
const sheetWidth = columns * tileWidth + (columns + 1) * gap
const sheetHeight = rows * tileHeight + (rows + 1) * gap
const sheet = Buffer.alloc(sheetWidth * sheetHeight * 4, 24)
for (let index = 0; index < sheetHeight * sheetWidth; index += 1) sheet[index * 4 + 3] = 255
results.forEach((result, index) => {
  if (result.pixels === undefined) return
  const column = index % columns
  const row = Math.floor(index / columns)
  scaleInto(sheet, sheetWidth, result.pixels, W, H, gap + column * (tileWidth + gap), gap + row * (tileHeight + gap), tileWidth, tileHeight)
})
const sheetPath = join(out, 'contact-sheet.png')
writeFileSync(sheetPath, encodePng(sheetWidth, sheetHeight, sheet))

// --- verdicts
const failures = []
const check = (name, condition, detail) => {
  if (condition) console.log('  ok   ' + name)
  else { console.log('  FAIL ' + name + (detail === undefined ? '' : ' -> ' + JSON.stringify(detail))); failures.push(name) }
}
const LOSSLESS = new Set(['png', 'tiff', 'psd', 'bmp', 'tga', 'pnm'])
for (const result of results) {
  if (result.error !== undefined) { check(result.name + ' is previewable', false, result.error); continue }
  check(result.name + ' keeps its size', result.dimensions === W + 'x' + H, result.dimensions)
  const limit = LOSSLESS.has(result.format) ? 1 : 14
  check(result.name + ' pixels match (mae ' + String(result.mae) + ' <= ' + String(limit) + ')', result.mae <= limit, { mae: result.mae, via: result.via, mediaType: result.mediaType })
  check(result.name + ' is not vertically flipped', result.mae < result.maeFlipped, { straight: result.mae, flipped: result.maeFlipped })
  check(result.name + ' has no red/blue swap', result.mae < result.maeSwapped, { straight: result.mae, swapped: result.maeSwapped })
}
// The chain above always reaches sips first, so the hand-written decoders --
// the ones that have to get BGR order and the bottom-left origin right by
// themselves -- are measured directly here. This is the path a Linux or
// Windows machine without sips/ImageMagick/ffmpeg actually takes.
const { decodeTga, decodePnm } = await import('../lib/index.js')
const builtinTga = decodePng(decodeTga(readFileSync(join(out, 'art.tga'))))
check('built-in TGA decoder: exact pixels', meanError(source, builtinTga.rgba) === 0, meanError(source, builtinTga.rgba))
check('built-in TGA decoder: correct origin', meanError(source, builtinTga.rgba) < meanError(flipVertical(source, W, H), builtinTga.rgba))
check('built-in TGA decoder: correct channel order', meanError(source, builtinTga.rgba) < meanError(swapRedBlue(source), builtinTga.rgba))
const builtinPnm = decodePng(decodePnm(readFileSync(join(out, 'plot.ppm'))))
check('built-in Netpbm decoder: exact pixels', meanError(source, builtinPnm.rgba) === 0, meanError(source, builtinPnm.rgba))
check('built-in Netpbm decoder: correct origin', meanError(source, builtinPnm.rgba) < meanError(flipVertical(source, W, H), builtinPnm.rgba))

console.log('\\ncontact sheet: ' + sheetPath)
console.log('order: ' + results.map((result) => result.name).join(', '))
console.log(skipped.length === 0 ? 'skipped: none' : 'skipped (no local fixture): ' + skipped.join(', '))
console.log(JSON.stringify(results.map(({ pixels: _pixels, ...rest }) => rest), null, 1))
console.log(failures.length === 0 ? '\nALL PASS' : '\n' + String(failures.length) + ' FAILING: ' + failures.join(', '))
