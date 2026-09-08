// End-to-end over real HTTP: mount the host half on a throwaway Node server
// and fetch through it, so headers, status codes and bytes are exercised the
// way the browser will exercise them.
import { createServer } from 'node:http'
import { join } from 'node:path'
import { apply, sniffFormat } from '../lib/index.js'

const fixtures = join(import.meta.dirname, 'fixtures')
const failures = []
const check = (name, condition, detail) => {
  if (condition) console.log('  ok   ' + name)
  else { console.log('  FAIL ' + name + (detail === undefined ? '' : ' -> ' + JSON.stringify(detail))); failures.push(name) }
}

const routes = new Map()
apply({ inject: (_services, run) => run({ webServer: { register: (route) => routes.set(route.path, route) }, get: () => undefined }) }, { allowRoots: [fixtures] })

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  const route = routes.get(path)
  if (route === undefined) {
    res.writeHead(404).end()
    return
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    res.writeHead(500).end(String(error))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = 'http://127.0.0.1:' + String(server.address().port)
const ask = (route, path, extra = '', init = undefined) =>
  fetch(base + '/image-preview/' + route + '?path=' + encodeURIComponent(join(fixtures, path)) + extra, init)

// --- a browser-native format: bytes must arrive untouched
const pngMeta = await (await ask('meta', 'base.png')).json()
check('meta: native PNG is ok', pngMeta.ok === true && pngMeta.mediaType === 'image/png' && pngMeta.transcoded === false, pngMeta)
const pngResponse = await ask('file', 'base.png', '&v=' + pngMeta.version)
const pngBytes = Buffer.from(await pngResponse.arrayBuffer())
check('file: PNG serves image/png', pngResponse.headers.get('content-type') === 'image/png')
check('file: PNG bytes are a real PNG', sniffFormat(pngBytes) === 'png')
check('file: PNG is cacheable and inline', pngResponse.headers.get('cache-control').includes('immutable') && pngResponse.headers.get('content-disposition') === 'inline')

// --- a format the browser cannot render: must arrive transcoded
const heicMeta = await (await ask('meta', 'sample.heic')).json()
check('meta: HEIC reports a PNG transcode', heicMeta.ok === true && heicMeta.mediaType === 'image/png' && heicMeta.transcoded === true && heicMeta.format === 'heic', heicMeta)
const heicResponse = await ask('file', 'sample.heic', '&v=' + heicMeta.version)
const heicBytes = Buffer.from(await heicResponse.arrayBuffer())
check('file: HEIC arrives as PNG bytes', sniffFormat(heicBytes) === 'png' && heicResponse.headers.get('content-type') === 'image/png')
check('file: transcoded size is sane', heicBytes.length > 100, heicBytes.length)

// --- SVG stays SVG
const svgResponse = await ask('file', 'sample.svg', '&v=1')
check('file: SVG keeps its own media type', svgResponse.headers.get('content-type') === 'image/svg+xml')
check('file: SVG is sent with nosniff', svgResponse.headers.get('x-content-type-options') === 'nosniff')

// --- refusals over the wire
const decoy = await ask('meta', 'decoy.png')
check('http: a fake image is refused with 403', decoy.status === 403 && (await decoy.json()).reason === 'not-an-image')
const missing = await ask('meta', 'nope.png')
check('http: a missing file is 404', missing.status === 404)
const escape = await fetch(base + '/image-preview/file?path=' + encodeURIComponent('/etc/passwd'))
check('http: a system path is refused', escape.status === 403, escape.status)

// --- the cross-site guard
const crossSite = await ask('file', 'base.png', '&v=1', { headers: { 'sec-fetch-site': 'cross-site' } })
check('http: a cross-site request is refused', crossSite.status === 403 && (await crossSite.json()).reason === 'cross-site')
const sameOrigin = await ask('file', 'base.png', '&v=1', { headers: { 'sec-fetch-site': 'same-origin' } })
check('http: a same-origin request is served', sameOrigin.status === 200)
const noMetadata = await ask('file', 'base.png', '&v=1')
check('http: a caller without Fetch-Metadata is served', noMetadata.status === 200)

server.close()
console.log(failures.length === 0 ? '\nALL PASS' : '\n' + String(failures.length) + ' FAILING: ' + failures.join(', '))
process.exit(failures.length === 0 ? 0 : 1)
