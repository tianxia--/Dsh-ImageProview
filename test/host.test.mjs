// Drives the host half's two routes without a web server: apply() is given a
// stub ctx that captures the handlers, which are then called with fake
// req/res pairs over the generated fixtures.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply, sniffFormat, decodeTga, decodePnm } from '../lib/index.js'

const fixtures = join(import.meta.dirname, 'fixtures')
const failures = []
const check = (name, condition, detail) => {
  if (condition) console.log('  ok   ' + name)
  else { console.log('  FAIL ' + name + (detail === undefined ? '' : ' -> ' + JSON.stringify(detail))); failures.push(name) }
}

function mount(config = {}) {
  const routes = new Map()
  const scope = {
    webServer: { register: (route) => { routes.set(route.path, route) } },
    get: () => undefined
  }
  const ctx = { inject: (_services, run) => run(scope) }
  apply(ctx, { allowRoots: [fixtures], ...config })
  return routes
}

async function call(route, url, method = 'GET') {
  const chunks = []
  let status
  let headers
  const res = {
    writeHead: (code, map) => { status = code; headers = map ?? {}; return res },
    end: (body) => { if (body !== undefined) chunks.push(Buffer.from(body)) }
  }
  await route.handler({ url, method }, res)
  const body = Buffer.concat(chunks)
  const type = headers?.['content-type'] ?? ''
  return { status, headers, body, json: type.includes('json') ? JSON.parse(body.toString('utf8')) : undefined }
}

const routes = mount()
check('mounts the meta route', routes.has('/image-preview/meta'))
check('mounts the file route', routes.has('/image-preview/file'))
const meta = routes.get('/image-preview/meta')
const file = routes.get('/image-preview/file')
const q = (path, extra = '') => '/image-preview/meta?path=' + encodeURIComponent(path) + extra
const qf = (path, extra = '') => '/image-preview/file?path=' + encodeURIComponent(path) + extra

// --- every fixture that is a real image must be previewable
const expected = {
  'base.png': { format: 'png', mediaType: 'image/png', transcoded: false },
  'sample-copy.png': { format: 'png', mediaType: 'image/png', transcoded: false },
  'sample.jpg': { format: 'jpeg', mediaType: 'image/jpeg', transcoded: false },
  'sample.gif': { format: 'gif', mediaType: 'image/gif', transcoded: false },
  'sample.bmp': { format: 'bmp', mediaType: 'image/bmp', transcoded: false },
  'sample.svg': { format: 'svg', mediaType: 'image/svg+xml', transcoded: false },
  'sample.ico': { format: 'ico', mediaType: 'image/x-icon', transcoded: false },
  'sample.tiff': { format: 'tiff', mediaType: 'image/png', transcoded: true },
  'sample.heic': { format: 'heic', mediaType: 'image/png', transcoded: true },
  'sample.jp2': { format: 'jp2', mediaType: 'image/png', transcoded: true },
  'sample.psd': { format: 'psd', mediaType: 'image/png', transcoded: true },
  'sample.tga': { format: 'tga', mediaType: 'image/png', transcoded: true },
  'sample.ppm': { format: 'pnm', mediaType: 'image/png', transcoded: true }
}
for (const name of readdirSync(fixtures).sort()) {
  if (name === 'decoy.png') continue
  const want = expected[name]
  if (want === undefined) { check('fixture ' + name + ' has an expectation', false); continue }
  const answer = await call(meta, q(join(fixtures, name)))
  const ok = answer.status === 200 && answer.json?.ok === true && answer.json.mediaType === want.mediaType && answer.json.transcoded === want.transcoded
  check(name + ' -> ' + want.mediaType + (want.transcoded ? ' (transcoded)' : ''), ok, answer.json)
  if (ok) check(name + ' reports 64x40', answer.json.width === 64 && answer.json.height === 40, { w: answer.json.width, h: answer.json.height })
}

// --- the bytes route
const bytes = await call(file, qf(join(fixtures, 'sample.tiff'), '&v=123'))
check('file route serves transcoded PNG bytes', bytes.status === 200 && sniffFormat(bytes.body) === 'png', bytes.status)
check('file route sets an immutable cache header', String(bytes.headers['cache-control']).includes('immutable'), bytes.headers['cache-control'])
check('file route sets nosniff', bytes.headers['x-content-type-options'] === 'nosniff')
check('file route content-length matches', Number(bytes.headers['content-length']) === bytes.body.length)
const unversioned = await call(file, qf(join(fixtures, 'base.png')))
check('unversioned request is not cached', String(unversioned.headers['cache-control']).includes('no-store'), unversioned.headers['cache-control'])
const head = await call(file, qf(join(fixtures, 'base.png'), '&v=1'), 'HEAD')
check('HEAD returns headers without a body', head.status === 200 && head.body.length === 0)

// --- refusals
const refusals = [
  ['a file whose bytes are not an image', q(join(fixtures, 'decoy.png')), 403, 'not-an-image'],
  ['a path outside every allowed root', q('/etc/hosts'), 403, 'extension-not-allowed'],
  ['a traversal attempt', q(join(fixtures, '..', '..', '..', 'etc', 'passwd.png')), 404, 'not-found'],
  ['a missing file', q(join(fixtures, 'nope.png')), 404, 'not-found'],
  ['a disallowed extension', q(join(fixtures, 'notes.txt')), 403, 'extension-not-allowed'],
  ['a relative path with no cwd', q('shot.png'), 403, 'relative-without-cwd'],
  ['an empty path', '/image-preview/meta', 403, 'bad-path'],
  ['a NUL-poisoned path', q('/tmp/x\u0000.png'), 403, 'bad-path']
]
for (const [name, url, status, reason] of refusals) {
  const answer = await call(meta, url)
  check('refuses ' + name, answer.status === status && answer.json?.reason === reason, { status: answer.status, json: answer.json })
}

// --- an image outside the allowed roots, reachable only by absolute path
const outside = await call(meta, q('/System/Library/CoreServices/SystemVersion.png'))
check('refuses an image outside the roots', outside.json?.ok !== true, outside.json)

// --- relative resolution against the conversation cwd
const relative = await call(meta, q('base.png', '&cwd=' + encodeURIComponent(fixtures)))
check('resolves a relative path against cwd', relative.json?.ok === true && relative.json.name === 'base.png', relative.json)

// --- config switches
const noTranscode = mount({ transcode: false }).get('/image-preview/meta')
const blocked = await call(noTranscode, q(join(fixtures, 'sample.heic')))
check('transcode:false refuses non-native formats', blocked.status === 415 && blocked.json?.reason === 'transcode-disabled', blocked.json)
const nativeStillWorks = await call(noTranscode, q(join(fixtures, 'base.png')))
check('transcode:false still serves native formats', nativeStillWorks.json?.ok === true)
const tinyCap = mount({ maxBytes: 100 }).get('/image-preview/meta')
const tooBig = await call(tinyCap, q(join(fixtures, 'base.png')))
check('maxBytes is enforced', tooBig.status === 413 && tooBig.json?.reason === 'too-large', tooBig.json)

// --- the built-in decoders, independent of any system transcoder
const tgaPng = decodeTga(readFileSync(join(fixtures, 'sample.tga')))
check('built-in TGA decoder produces a PNG', tgaPng !== undefined && sniffFormat(tgaPng) === 'png')
const pnmPng = decodePnm(readFileSync(join(fixtures, 'sample.ppm')))
check('built-in Netpbm decoder produces a PNG', pnmPng !== undefined && sniffFormat(pnmPng) === 'png')
check('built-in decoders reject garbage', decodeTga(Buffer.alloc(4)) === undefined && decodePnm(Buffer.from('P9\n')) === undefined)

console.log(failures.length === 0 ? '\nALL PASS' : '\n' + String(failures.length) + ' FAILING: ' + failures.join(', '))
process.exit(failures.length === 0 ? 0 : 1)
