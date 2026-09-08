// Host half of dsh-image-preview.
//
// Two jobs, both in service of the browser half:
//
//   GET /image-preview/meta?path=…&cwd=…  -> { ok, mediaType, width, height, … }
//   GET /image-preview/file?path=…&cwd=…&v=…  -> the displayable bytes
//
// The browser cannot read local disk, and the images the agent produces are
// ordinary files on it. The attachment path (read_image) only admits
// PNG/JPEG/WebP/GIF, so every other format — BMP, TIFF, HEIC, SVG, ICO, PSD,
// TGA, PNM, JP2 … — has no way into the flow at all. This route is that way
// in: it validates the path, sniffs the real bytes, serves browser-native
// formats untouched, and transcodes the rest to PNG.
//
// Both routes ride ctx.inject(['webServer'], …), so a headless profile never
// mounts them. They also sit behind dsh web's authentication gate like every
// other route, so only the authenticated browser session can read files
// through them.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { deflateSync } from 'node:zlib'

const execFileAsync = promisify(execFile)

/** Hard ceiling on a single source file, overridable by config. */
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024
/** Transcode cache entries kept before the oldest are dropped. */
const CACHE_ENTRY_CAP = 240
/** How long a resolved workspace-root list is reused. */
const ROOTS_TTL_MS = 10_000
/** Bound on one transcoder run. */
const TRANSCODE_TIMEOUT_MS = 20_000

/** Extensions this plugin will even consider (defense in depth beside sniffing). */
const ALLOWED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.jpe', '.gif', '.webp', '.avif', '.bmp', '.dib', '.ico', '.cur',
  '.svg', '.svgz', '.tif', '.tiff', '.heic', '.heif', '.hif', '.psd', '.tga', '.icb', '.vda', '.vst',
  '.jp2', '.j2k', '.jpf', '.jpx', '.pnm', '.pbm', '.pgm', '.ppm', '.pam', '.jxl', '.exr', '.dds'
])

/** Media types a browser renders directly: served byte-for-byte. */
const NATIVE_MEDIA_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'image/bmp', 'image/x-icon', 'image/svg+xml'
])

/**
 * Identify an image from its leading bytes. Extensions lie; this is what
 * decides both the served content-type and whether the file is an image at
 * all — a path that sniffs as anything else is refused rather than streamed.
 * @param bytes - the head of the file (>= 64 bytes when available).
 * @returns a stable format id, or undefined when nothing matches.
 */
export function sniffFormat(bytes, hintExtension) {
  const u8 = bytes
  const ascii = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) if (u8[offset + index] !== text.charCodeAt(index)) return false
    return true
  }
  if (u8.length >= 8 && u8[0] === 0x89 && ascii(1, 'PNG')) return 'png'
  if (u8.length >= 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'jpeg'
  if (u8.length >= 6 && ascii(0, 'GIF8')) return 'gif'
  if (u8.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'webp'
  if (u8.length >= 12 && ascii(4, 'ftyp')) {
    const brand = String.fromCharCode(u8[8], u8[9], u8[10], u8[11])
    if (brand.startsWith('avi')) return 'avif'
    if (brand.startsWith('hei') || brand.startsWith('mif') || brand.startsWith('msf') || brand.startsWith('hev')) return 'heic'
  }
  if (u8.length >= 2 && ascii(0, 'BM')) return 'bmp'
  // ICO/CUR and TGA collide exactly: an ICO header is 00 00 <01|02> 00 and a
  // truecolor TGA header is 00 00 02 00 as well. TGA has no magic number at
  // all, so this is decided by three ordered signals instead: the honest
  // extension, TGA's optional trailer, then per-format plausibility.
  if (u8.length >= 6 && u8[0] === 0x00 && (u8[1] === 0x00 || u8[1] === 0x01) && u8[3] === 0x00) {
    const tgaExtensions = new Set(['.tga', '.icb', '.vda', '.vst'])
    const isTgaType = [1, 2, 3, 9, 10, 11].includes(u8[2])
    const isIcoType = u8[2] === 0x01 || u8[2] === 0x02
    if (hintExtension !== undefined && tgaExtensions.has(hintExtension) && isTgaType) return 'tga'
    if (hintExtension === '.ico' || hintExtension === '.cur') { if (isIcoType) return 'ico' }
    const trailer = u8.length >= 18 ? Buffer.from(u8.subarray(u8.length - 18)).toString('latin1') : ''
    if (trailer.includes('TRUEVISION-XFILE') && isTgaType) return 'tga'
    if (isIcoType) {
      const count = u8[4] | (u8[5] << 8)
      const plausibleIco = count >= 1 && count <= 64 && u8.length >= 6 + count * 16
      if (plausibleIco) return 'ico'
    }
    if (isTgaType && u8.length >= 18) {
      const width = u8[12] | (u8[13] << 8)
      const height = u8[14] | (u8[15] << 8)
      if (width > 0 && height > 0 && [8, 15, 16, 24, 32].includes(u8[16])) return 'tga'
    }
    if (isIcoType) return 'ico'
  }
  if (u8.length >= 4 && (ascii(0, 'II*\u0000') || ascii(0, 'MM\u0000*'))) return 'tiff'
  if (u8.length >= 4 && ascii(0, '8BPS')) return 'psd'
  if (u8.length >= 12 && ascii(4, 'jP  ')) return 'jp2'
  if (u8.length >= 12 && u8[0] === 0x00 && u8[1] === 0x00 && u8[2] === 0x00 && ascii(4, 'jP')) return 'jp2'
  if (u8.length >= 4 && ascii(0, 'DDS ')) return 'dds'
  if (u8.length >= 2 && ascii(0, '\u0000\u0000')) {
    // Netpbm and TGA share a weak signature space; Netpbm is checked first
    // because its magic is textual and unambiguous.
  }
  if (u8.length >= 2 && u8[0] === 0x50 && u8[1] >= 0x31 && u8[1] <= 0x37) return 'pnm'
  if (u8.length >= 12 && ascii(0, '\u0000\u0000\u0000\fJXL')) return 'jxl'
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0x0a) return 'jxl'
  // PDF is deliberately absent: it is a document, its rasterization DPI is a
  // choice rather than a property, and a measured round trip came back at
  // MAE 34 against the source. Previewing documents belongs to a document
  // plugin, not to this one.
  if (u8.length >= 4 && ascii(0, 'v/1\u0001')) return 'exr'
  const head = Buffer.from(u8.subarray(0, Math.min(u8.length, 1024))).toString('utf8').trimStart()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg'
  return undefined
}

/** Format id -> media type; the transcoded ones report PNG once converted. */
const MEDIA_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  tiff: 'image/tiff',
  heic: 'image/heic',
  psd: 'image/vnd.adobe.photoshop',
  jp2: 'image/jp2',
  dds: 'image/vnd-ms.dds',
  pnm: 'image/x-portable-anymap',
  tga: 'image/x-tga',
  jxl: 'image/jxl',
  exr: 'image/aces'
}

/**
 * Read intrinsic dimensions from a header without decoding pixels. Only the
 * formats the browser renders natively need this (the rest are measured on
 * their transcoded PNG), so an unknown answer is acceptable and simply means
 * "let the gallery pick its default box".
 * @param format - sniffed format id.
 * @param bytes - file head.
 * @returns width/height when cheaply knowable.
 */
export function readDimensions(format, bytes) {
  const view = Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.length)
  try {
    if (format === 'png' && view.length >= 24) return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) }
    if (format === 'gif' && view.length >= 10) return { width: view.readUInt16LE(6), height: view.readUInt16LE(8) }
    if (format === 'bmp' && view.length >= 26) return { width: Math.abs(view.readInt32LE(18)), height: Math.abs(view.readInt32LE(22)) }
    if (format === 'ico' && view.length >= 8) {
      const width = view[6] === 0 ? 256 : view[6]
      const height = view[7] === 0 ? 256 : view[7]
      return { width, height }
    }
    if (format === 'webp' && view.length >= 30) {
      const chunk = view.subarray(12, 16).toString('ascii')
      if (chunk === 'VP8X') return { width: 1 + view.readUIntLE(24, 3), height: 1 + view.readUIntLE(27, 3) }
      if (chunk === 'VP8 ') return { width: view.readUInt16LE(26) & 0x3fff, height: view.readUInt16LE(28) & 0x3fff }
      if (chunk === 'VP8L') {
        const bits = view.readUInt32LE(21)
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
      }
    }
    if (format === 'jpeg') {
      let offset = 2
      while (offset + 9 < view.length) {
        if (view[offset] !== 0xff) { offset += 1; continue }
        const marker = view[offset + 1]
        const length = view.readUInt16BE(offset + 2)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: view.readUInt16BE(offset + 5), width: view.readUInt16BE(offset + 7) }
        }
        offset += 2 + length
      }
    }
    if (format === 'svg') {
      const text = view.subarray(0, Math.min(view.length, 4096)).toString('utf8')
      const number = (name) => {
        const found = new RegExp(name + '\\s*=\\s*["\']([0-9.]+)', 'i').exec(text)
        return found === null ? undefined : Math.round(Number(found[1]))
      }
      const width = number('width')
      const height = number('height')
      if (width !== undefined && height !== undefined) return { width, height }
      const box = /viewBox\s*=\s*["']\s*[-0-9.]+\s+[-0-9.]+\s+([0-9.]+)\s+([0-9.]+)/i.exec(text)
      if (box !== null) return { width: Math.round(Number(box[1])), height: Math.round(Number(box[2])) }
    }
  } catch {
    return undefined
  }
  return undefined
}

//#region zero-dependency PNG encoding, used by the built-in fallback decoders
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const tag = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([tag, data])))
  return Buffer.concat([length, tag, data, crc])
}

/**
 * Encode RGBA pixels as a PNG. Used only by the built-in fallback decoders,
 * so a machine without any system transcoder still shows TGA and Netpbm.
 * @param width - pixel width.
 * @param height - pixel height.
 * @param rgba - width*height*4 bytes.
 * @returns PNG bytes.
 */
export function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * Decode the uncompressed and RLE TGA types (2, 3, 10, 11) at 8/16/24/32 bpp.
 * @param bytes - whole TGA file.
 * @returns PNG bytes, or undefined when the subtype is not covered.
 */
export function decodeTga(bytes) {
  if (bytes.length < 18) return undefined
  const idLength = bytes[0]
  const type = bytes[2]
  const width = bytes.readUInt16LE(12)
  const height = bytes.readUInt16LE(14)
  const depth = bytes[16]
  const descriptor = bytes[17]
  if (width <= 0 || height <= 0 || width * height > 64_000_000) return undefined
  if (![2, 3, 10, 11].includes(type)) return undefined
  if (![8, 15, 16, 24, 32].includes(depth)) return undefined
  const bytesPerPixel = Math.ceil(depth / 8)
  let offset = 18 + idLength
  const pixelCount = width * height
  const flat = Buffer.alloc(pixelCount * bytesPerPixel)
  if (type === 2 || type === 3) {
    if (bytes.length < offset + flat.length) return undefined
    bytes.copy(flat, 0, offset, offset + flat.length)
  } else {
    let written = 0
    while (written < flat.length && offset < bytes.length) {
      const packet = bytes[offset]
      offset += 1
      const count = (packet & 0x7f) + 1
      if ((packet & 0x80) !== 0) {
        if (offset + bytesPerPixel > bytes.length) return undefined
        for (let index = 0; index < count && written < flat.length; index += 1) {
          bytes.copy(flat, written, offset, offset + bytesPerPixel)
          written += bytesPerPixel
        }
        offset += bytesPerPixel
      } else {
        const span = count * bytesPerPixel
        if (offset + span > bytes.length) return undefined
        bytes.copy(flat, written, offset, offset + span)
        written += span
        offset += span
      }
    }
  }
  const rgba = Buffer.alloc(pixelCount * 4)
  for (let index = 0; index < pixelCount; index += 1) {
    const source = index * bytesPerPixel
    let r = 0
    let g = 0
    let b = 0
    let a = 255
    if (depth === 8) { r = g = b = flat[source] }
    else if (depth === 15 || depth === 16) {
      const value = flat.readUInt16LE(source)
      r = Math.round((((value >> 10) & 0x1f) * 255) / 31)
      g = Math.round((((value >> 5) & 0x1f) * 255) / 31)
      b = Math.round(((value & 0x1f) * 255) / 31)
      if (depth === 16) a = (value & 0x8000) === 0 ? 255 : 255
    } else {
      b = flat[source]
      g = flat[source + 1]
      r = flat[source + 2]
      if (depth === 32) a = flat[source + 3]
    }
    const target = index * 4
    rgba[target] = r
    rgba[target + 1] = g
    rgba[target + 2] = b
    rgba[target + 3] = a
  }
  // Bit 5 of the descriptor selects a top-left origin; the default is
  // bottom-left, which has to be flipped for PNG's top-down rows.
  if ((descriptor & 0x20) === 0) {
    const stride = width * 4
    const flipped = Buffer.alloc(rgba.length)
    for (let y = 0; y < height; y += 1) rgba.copy(flipped, (height - 1 - y) * stride, y * stride, y * stride + stride)
    return encodePng(width, height, flipped)
  }
  return encodePng(width, height, rgba)
}

/**
 * Decode binary Netpbm (P4/P5/P6); the ASCII variants are rare enough to
 * leave to a system transcoder.
 * @param bytes - whole PNM file.
 * @returns PNG bytes, or undefined when unsupported.
 */
export function decodePnm(bytes) {
  if (bytes.length < 10) return undefined
  const kind = bytes[1]
  if (![0x34, 0x35, 0x36].includes(kind)) return undefined
  let offset = 2
  const fields = []
  while (fields.length < (kind === 0x34 ? 2 : 3) && offset < bytes.length) {
    while (offset < bytes.length && /\s/.test(String.fromCharCode(bytes[offset]))) offset += 1
    if (bytes[offset] === 0x23) {
      while (offset < bytes.length && bytes[offset] !== 0x0a) offset += 1
      continue
    }
    let token = ''
    while (offset < bytes.length && /[0-9]/.test(String.fromCharCode(bytes[offset]))) { token += String.fromCharCode(bytes[offset]); offset += 1 }
    if (token === '') return undefined
    fields.push(Number(token))
  }
  offset += 1
  const [width, height] = fields
  const maximum = kind === 0x34 ? 1 : fields[2]
  if (!(width > 0 && height > 0) || width * height > 64_000_000 || maximum <= 0 || maximum > 255) return undefined
  const rgba = Buffer.alloc(width * height * 4, 255)
  for (let index = 0; index < width * height; index += 1) {
    const target = index * 4
    if (kind === 0x36) {
      const source = offset + index * 3
      if (source + 2 >= bytes.length) return undefined
      rgba[target] = bytes[source]
      rgba[target + 1] = bytes[source + 1]
      rgba[target + 2] = bytes[source + 2]
    } else if (kind === 0x35) {
      const value = bytes[offset + index]
      if (value === undefined) return undefined
      rgba[target] = rgba[target + 1] = rgba[target + 2] = Math.round((value * 255) / maximum)
    } else {
      const bit = (bytes[offset + Math.floor(index / 8)] >> (7 - (index % 8))) & 1
      const value = bit === 1 ? 0 : 255
      rgba[target] = rgba[target + 1] = rgba[target + 2] = value
    }
  }
  return encodePng(width, height, rgba)
}
//#endregion

/** Cache directory for transcoded PNGs, private to this user. */
function cacheDirectory() {
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  const directory = join(home, 'plugins-cache', 'image-preview')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  return directory
}

/** Drop the oldest cached transcodes once the entry cap is passed. */
function pruneCache(directory) {
  let entries
  try {
    entries = readdirSync(directory).map((name) => {
      const full = join(directory, name)
      return { full, mtime: statSync(full).mtimeMs }
    })
  } catch {
    return
  }
  if (entries.length <= CACHE_ENTRY_CAP) return
  entries.sort((left, right) => left.mtime - right.mtime)
  for (const entry of entries.slice(0, entries.length - CACHE_ENTRY_CAP)) {
    try { unlinkSync(entry.full) } catch { /* raced with another prune */ }
  }
}

/**
 * Convert one file to PNG. System transcoders are preferred because they
 * cover the formats no hand-written decoder should attempt (HEIC, TIFF
 * variants, PSD, JP2, RAW); the built-in decoders keep TGA and Netpbm
 * working on a machine that has none of them.
 * @param sourcePath - validated real path.
 * @param format - sniffed format id.
 * @param bytes - whole file, already read for sniffing.
 * @returns PNG bytes with dimensions, or a reason it could not be shown.
 */
async function transcodeToPng(sourcePath, format, bytes) {
  const targets = []
  if (process.platform === 'darwin') targets.push({ command: 'sips', argv: (input, output) => ['-s', 'format', 'png', input, '--out', output] })
  targets.push({ command: 'magick', argv: (input, output) => [input + '[0]', output] })
  targets.push({ command: 'convert', argv: (input, output) => [input + '[0]', output] })
  targets.push({ command: 'ffmpeg', argv: (input, output) => ['-y', '-i', input, '-frames:v', '1', output] })

  const directory = cacheDirectory()
  const stats = statSync(sourcePath)
  const key = createHash('sha1').update(sourcePath).update('\u0000').update(String(stats.mtimeMs)).update('\u0000').update(String(stats.size)).digest('hex').slice(0, 24)
  const cached = join(directory, key + '.png')
  try {
    const hit = readFileSync(cached)
    return { bytes: hit, dimensions: readDimensions('png', hit) }
  } catch { /* cold cache */ }

  for (const target of targets) {
    try {
      await execFileAsync(target.command, target.argv(sourcePath, cached), { timeout: TRANSCODE_TIMEOUT_MS })
      const produced = readFileSync(cached)
      if (sniffFormat(produced) !== 'png') throw new Error('transcoder produced a non-PNG file')
      pruneCache(directory)
      return { bytes: produced, dimensions: readDimensions('png', produced), via: target.command }
    } catch { /* try the next transcoder */ }
  }

  const builtin = format === 'tga' || extname(sourcePath).toLowerCase() === '.tga'
    ? decodeTga(bytes)
    : format === 'pnm' ? decodePnm(bytes) : undefined
  if (builtin !== undefined) {
    try {
      writeFileSync(cached, builtin, { mode: 0o600 })
      pruneCache(directory)
    } catch { /* cache is an optimization, not a requirement */ }
    return { bytes: builtin, dimensions: readDimensions('png', builtin), via: 'builtin' }
  }
  return { reason: 'no-transcoder' }
}

/**
 * Resolve and authorize one requested path. Refusal is the default: the
 * realpath must be a regular file under an allowed root, carry an allowed
 * extension, stay under the byte cap, and sniff as an actual image.
 * @param query - request query with path and optional cwd.
 * @param roots - allowed root real paths.
 * @param maxBytes - configured ceiling.
 * @returns the resolved file description or a refusal reason.
 */
function authorize(query, roots, maxBytes) {
  const raw = query.get('path')
  if (raw === null || raw === '' || raw.includes('\u0000')) return { reason: 'bad-path' }
  const cwd = query.get('cwd')
  const candidate = isAbsolute(raw) ? raw : cwd !== null && cwd !== '' && isAbsolute(cwd) ? resolve(cwd, raw) : undefined
  if (candidate === undefined) return { reason: 'relative-without-cwd' }
  if (!ALLOWED_EXTENSIONS.has(extname(candidate).toLowerCase())) return { reason: 'extension-not-allowed' }
  let real
  try {
    real = realpathSync(candidate)
  } catch {
    return { reason: 'not-found' }
  }
  const inside = roots.some((rootPath) => real === rootPath || real.startsWith(rootPath.endsWith(sep) ? rootPath : rootPath + sep))
  if (!inside) return { reason: 'outside-allowed-roots' }
  let stats
  try {
    stats = statSync(real)
  } catch {
    return { reason: 'not-found' }
  }
  if (!stats.isFile()) return { reason: 'not-a-file' }
  if (stats.size === 0) return { reason: 'empty' }
  if (stats.size > maxBytes) return { reason: 'too-large' }
  let bytes
  try {
    bytes = readFileSync(real)
  } catch {
    return { reason: 'unreadable' }
  }
  const format = sniffFormat(bytes, extname(real).toLowerCase())
  if (format === undefined) return { reason: 'not-an-image' }
  return { real, bytes, format, stats }
}

/** Everything the browser is allowed to ask about, recomputed on a short TTL. */
function rootResolver(ctx, configuredRoots) {
  let cachedRoots = []
  let cachedAt = 0
  const staticRoots = () => {
    const list = [tmpdir(), '/tmp', join(homedir(), '.dsh'), ...configuredRoots]
    if (process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== '') list.push(process.env.DSH_HOME)
    return list
  }
  return async () => {
    const now = Date.now()
    if (now - cachedAt < ROOTS_TTL_MS && cachedRoots.length > 0) return cachedRoots
    const candidates = staticRoots()
    // Every workspace the host knows about: the agent's screenshots and
    // generated charts live there, and nothing outside it (or the temp dirs)
    // is readable through this route.
    try {
      const registry = ctx.get?.('workspaceRegistry')
      const headers = await registry?.indexHeaders?.()
      const rows = Array.isArray(headers) ? headers : Array.isArray(headers?.items) ? headers.items : []
      for (const row of rows) {
        for (const field of ['cwd', 'path', 'root']) {
          const value = row?.[field]
          if (typeof value === 'string' && value !== '') candidates.push(value)
        }
      }
    } catch { /* the registry is an enrichment, not a requirement */ }
    const resolved = []
    for (const candidate of candidates) {
      try {
        const real = realpathSync(candidate)
        if (!resolved.includes(real)) resolved.push(real)
      } catch { /* a root that does not exist cannot authorize anything */ }
    }
    cachedRoots = resolved
    cachedAt = now
    return resolved
  }
}

/**
 * Mount the preview routes.
 * @param ctx - plugin context.
 * @param config - optional plugin row config.
 */
export function apply(ctx, config = {}) {
  const maxBytes = typeof config.maxBytes === 'number' && config.maxBytes > 0 ? config.maxBytes : DEFAULT_MAX_BYTES
  const configuredRoots = Array.isArray(config.allowRoots) ? config.allowRoots.filter((entry) => typeof entry === 'string') : []
  const transcode = config.transcode !== false

  ctx.inject(['webServer'], (scope) => {
    const resolveRoots = rootResolver(scope, configuredRoots)

    /**
     * Plugin routes are mounted outside dsh web's cookie gate (the same place
     * @liustack/modlens mounts its paste route, which also answers an
     * unauthenticated request), so this route cannot lean on that gate. The
     * server binds loopback, which leaves exactly one reachable attacker: a
     * web page in this browser pointing an <img> at the route. It could not
     * read the pixels — canvas would be tainted — but load/error timing would
     * still let it probe which files exist. Browsers label that request
     * cross-site, and nothing in this plugin's own UI is cross-site, so the
     * label is refused. A caller that sends no Fetch-Metadata at all (curl,
     * a local script) is left alone: it can already read those files
     * directly, and refusing it would only break local debugging.
     */
    const crossSite = (req) => {
      const site = req.headers?.['sec-fetch-site']
      const value = Array.isArray(site) ? site[0] : site
      return typeof value === 'string' && value !== 'same-origin' && value !== 'none'
    }

    const answer = async (req, res, wantBytes) => {
      if (crossSite(req)) {
        res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: false, reason: 'cross-site' }))
        return
      }
      let query
      try {
        query = new URL(req.url ?? '/', 'http://localhost').searchParams
      } catch {
        res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: false, reason: 'bad-url' }))
        return
      }
      const roots = await resolveRoots()
      const resolved = authorize(query, roots, maxBytes)
      if (resolved.reason !== undefined) {
        const status = resolved.reason === 'not-found' ? 404 : resolved.reason === 'too-large' ? 413 : 403
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: false, reason: resolved.reason }))
        return
      }
      const native = NATIVE_MEDIA_TYPES.has(MEDIA_TYPES[resolved.format] ?? '')
      let payload = resolved.bytes
      let mediaType = MEDIA_TYPES[resolved.format] ?? 'application/octet-stream'
      let dimensions = readDimensions(resolved.format, resolved.bytes)
      let via
      if (!native) {
        if (!transcode) {
          res.writeHead(415, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: false, reason: 'transcode-disabled', format: resolved.format }))
          return
        }
        const converted = await transcodeToPng(resolved.real, resolved.format, resolved.bytes)
        if (converted.reason !== undefined) {
          res.writeHead(415, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ ok: false, reason: converted.reason, format: resolved.format }))
          return
        }
        payload = converted.bytes
        mediaType = 'image/png'
        dimensions = converted.dimensions
        via = converted.via
      }
      if (!wantBytes) {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({
          ok: true,
          path: resolved.real,
          name: basename(resolved.real),
          format: resolved.format,
          mediaType,
          bytes: resolved.stats.size,
          version: String(resolved.stats.mtimeMs),
          transcoded: !native,
          ...via === undefined ? {} : { via },
          ...dimensions === undefined ? {} : dimensions
        }))
        return
      }
      // The client always sends ?v=<mtimeMs>, so a changed file is a
      // different URL and this response can be cached hard.
      const versioned = query.get('v') !== null
      res.writeHead(200, {
        'content-type': mediaType,
        'content-length': String(payload.length),
        'cache-control': versioned ? 'private, max-age=604800, immutable' : 'no-store',
        'x-content-type-options': 'nosniff',
        'content-disposition': 'inline'
      })
      res.end(req.method === 'HEAD' ? undefined : payload)
    }

    scope.webServer.register({
      name: 'image-preview-meta',
      kind: 'exact',
      path: '/image-preview/meta',
      handler: (req, res) => answer(req, res, false)
    })
    scope.webServer.register({
      name: 'image-preview-file',
      kind: 'exact',
      path: '/image-preview/file',
      handler: (req, res) => answer(req, res, true)
    })
  })
}
