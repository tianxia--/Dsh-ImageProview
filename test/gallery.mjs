// Serves a gallery page whose <img> tags all point at the plugin's REAL
// /image-preview/file route, so a screenshot of this page is a screenshot of
// the plugin working, not a mockup. Usage: node test/gallery.mjs <port>
import { createServer } from 'node:http'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const fixtures = join(import.meta.dirname, 'fixtures')
const routes = new Map()
apply({ inject: (_services, run) => run({ webServer: { register: (route) => routes.set(route.path, route) }, get: () => undefined }) }, { allowRoots: [fixtures] })

const port = Number(process.argv[2] ?? 4573)
const names = readdirSync(fixtures).filter((name) => name !== 'decoy.png')

const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname
  if (pathname === '/gallery') {
    const cards = names.map((name) => {
      const path = join(fixtures, name)
      const query = 'path=' + encodeURIComponent(path)
      return '<figure><img loading="eager" src="/image-preview/file?' + query + '&v=1" alt="' + name + '">'
        + '<figcaption><code>' + name + '</code><span>via /image-preview/file</span></figcaption></figure>'
    }).join('\n')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><html><head><meta charset="utf-8"><style>'
      + 'body{margin:0;background:#16181d;color:#d7dae0;font:13px/1.4 -apple-system,Helvetica,Arial,sans-serif;padding:28px 32px}'
      + 'h1{font-size:19px;margin:0 0 4px}p.sub{margin:0 0 22px;color:#8b919c}p.sub code{color:#b9bec7}'
      + '.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;max-width:1180px}'
      + 'figure{margin:0;background:#1d2026;border:1px solid #2a2e36;border-radius:10px;overflow:hidden}'
      + 'figure img{display:block;width:100%;height:170px;object-fit:cover;background:#0f1115}'
      + 'figcaption{display:flex;justify-content:space-between;gap:8px;padding:8px 10px;font-size:12px}'
      + 'figcaption span{color:#8b919c}code{color:#7fb3ff}'
      + '</style></head><body><h1>dsh-image-preview &mdash; one route, every format</h1>'
      + '<p class="sub">Every thumbnail below is served by the plugin host route <code>/image-preview/file</code> &mdash; browser-native formats byte-for-byte, the rest transcoded to PNG (sips on this machine).</p>'
      + '<div class="grid">' + cards + '</div></body></html>')
    return
  }
  const route = routes.get(pathname)
  if (route === undefined) { res.writeHead(404).end(); return }
  Promise.resolve(route.handler(req, res)).catch(() => res.writeHead(500).end())
})
server.listen(port, '127.0.0.1')
console.log('gallery on http://127.0.0.1:' + port + '/gallery')
setInterval(() => {}, 60000)
