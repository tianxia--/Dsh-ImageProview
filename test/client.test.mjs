// Offline harness for the client half: loads lib/client.js with a stubbed
// module loader, drives both conversation Definitions with real event shapes,
// and renders both rows through react-dom/server (react is taken from
// react-dom's own resolution root so hooks share one React instance).
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// React comes from this package's own devDependencies, so the suite never
// depends on how a particular dsh release lays out its node_modules.
const localRequire = createRequire(import.meta.url)
const profileRequire = localRequire
const react = localRequire('react')
const jsxRuntime = localRequire('react/jsx-runtime')
const { renderToStaticMarkup } = localRequire('react-dom/server')

const fixtures = join(import.meta.dirname, 'fixtures')

// --- host route stub: the client only ever talks to /image-preview/meta
const served = new Map([
  ['/Users/agent/shot.heic', { ok: true, path: '/Users/agent/shot.heic', name: 'shot.heic', format: 'heic', mediaType: 'image/png', transcoded: true, version: '99', width: 64, height: 40 }],
  ['/tmp/plot.png', { ok: true, path: '/tmp/plot.png', name: 'plot.png', format: 'png', mediaType: 'image/png', transcoded: false, version: '7', width: 800, height: 600 }],
  ['diagram.svg', { ok: true, path: '/work/diagram.svg', name: 'diagram.svg', format: 'svg', mediaType: 'image/svg+xml', transcoded: false, version: '3', width: 100, height: 50 }]
])
let fetchCalls = 0
globalThis.fetch = (url) => {
  fetchCalls += 1
  const query = new URL(url, 'http://localhost').searchParams
  const answer = served.get(query.get('path'))
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(answer ?? { ok: false, reason: 'not-found' })
  })
}

let captured
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      captured = entry.factory((id) => (id === 'react' ? react : id === 'react/jsx-runtime' ? jsxRuntime : profileRequire(id)))
    }
  }
}
new Function(readFileSync(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8'))()

const failures = []
const check = (name, condition, detail) => {
  if (condition) console.log('  ok   ' + name)
  else { console.log('  FAIL ' + name + (detail === undefined ? '' : ' -> ' + JSON.stringify(detail))); failures.push(name) }
}

check('exports.apply is a function', typeof captured.apply === 'function')
check('injects slots + uiConversation', JSON.stringify(captured.inject) === '["slots","uiConversation"]', captured.inject)

// --- what apply() registers
const definitions = new Map()
const registrations = new Map()
const ctx = {
  uiConversation: { events: { register: (definition) => { definitions.set(definition.kind, definition); return () => {} } } },
  slots: {
    inject: (name, run) => { check('injects into conversation.chat.node', name === 'conversation.chat.node', name); run() },
    register: (options, component) => { registrations.set(options.key, component); return () => {} }
  }
}
captured.apply(ctx)

check('registers both Definitions', definitions.size === 2 && definitions.has('agent-image-preview') && definitions.has('agent-image-path-preview'), [...definitions.keys()])
check('registers both node seats', registrations.size === 2 && registrations.has('agent-image') && registrations.has('agent-image-path'), [...registrations.keys()])
check('both Definitions target chat', [...definitions.values()].every((definition) => definition.target === 'chat'))

const attachmentDefinition = definitions.get('agent-image-preview')
const pathDefinition = definitions.get('agent-image-path-preview')

// --- fixture events, shaped exactly like the durable log
const agentAttachment = {
  type: 'user/message', seq: 412, time: 1788500000000,
  data: {
    id: 'msg-7', role: 'user', source: { kind: 'plugin', plugin: 'tools-code-mode' },
    content: [
      { type: 'text', text: '<path>/tmp/tcr_shot.png</path>\n<type>image</type>\n<content>\nimage/png image, 840x2289 px, 972428 bytes\n</content>' },
      { type: 'image', attachment: { attachmentId: 'sha256:a17b82e2', mediaType: 'image/png', bytes: 972428, width: 840, height: 2289, name: 'tcr_shot.png' } }
    ]
  }
}
const humanPaste = {
  type: 'user/message', seq: 9, time: 1,
  data: { id: 'msg-1', role: 'user', source: { kind: 'user', rpcId: 'x' },
    content: [{ type: 'image', attachment: { attachmentId: 'sha256:beef', mediaType: 'image/png', bytes: 10, width: 2, height: 2, name: 'p.png' } }] }
}
const runtimeContext = {
  type: 'user/message', seq: 10, time: 2,
  // Any non-human source works here. A neutral id is used on purpose: a real
  // package specifier in a fixture reads as an undeclared dependency to naive
  // peer scanners (this exact string was once reported as one).
  data: { id: 'msg-2', role: 'user', source: { kind: 'plugin', plugin: 'runtime-context-snapshot' },
    content: [{ type: 'text', text: 'Current runtime context. Workspace: /Users/pengfei.chen/Desktop/x' }] }
}
const assistantWithMarkdown = {
  type: 'assistant/message', seq: 77, time: 3,
  data: { turn: 2, step: 1, message: { id: 'a-1', role: 'assistant', content: [
    { type: 'reasoning', text: 'thinking' },
    { type: 'text', text: 'Done. Result:\n\n![render](/Users/agent/shot.heic)\n\nAlso see /tmp/plot.png\n' }
  ] } }
}
const assistantProseOnly = {
  type: 'assistant/message', seq: 78, time: 4,
  data: { turn: 2, step: 2, message: { id: 'a-2', role: 'assistant', content: [
    { type: 'text', text: 'I edited src/app.png.ts and then ran the config.json migration; nothing to show.' }
  ] } }
}
const humanTypedPath = {
  type: 'user/message', seq: 90, time: 5,
  data: { id: 'msg-9', role: 'user', source: { kind: 'user', rpcId: 'y' },
    content: [{ type: 'text', text: '/Users/agent/shot.heic' }] }
}

// --- attachment Definition
check('attachment: matches the agent image event', attachmentDefinition.match(agentAttachment)?.id === 'msg-7')
check('attachment: ignores human pastes', attachmentDefinition.match(humanPaste) === null)
check('attachment: ignores text-only context', attachmentDefinition.match(runtimeContext) === null)
check('attachment: ignores assistant messages', attachmentDefinition.match(assistantWithMarkdown) === null)
const attachmentState = attachmentDefinition.start({}, { event: agentAttachment })
check('attachment: one gallery item of shape { attachment }', attachmentState.images.length === 1 && JSON.stringify(Object.keys(attachmentState.images[0])) === '["attachment"]')
check('attachment: parses the descriptor path', attachmentState.paths[0] === '/tmp/tcr_shot.png', attachmentState.paths)
const attachmentNode = attachmentDefinition.buildViewNode({ key: 'k1', id: 'msg-7', state: attachmentState, start: { location: { kind: 'step', turn: { turn: 3 }, step: { step: 2 } } }, matches: [] })
check('attachment: node kind matches its seat', attachmentNode.kind === 'agent-image' && attachmentNode.target === 'chat' && attachmentNode.anchorSeq === 412)

// --- path Definition
check('path: does NOT match a message that already has an attachment', pathDefinition.match(agentAttachment) === null)
check('path: matches assistant markdown images', pathDefinition.match(assistantWithMarkdown)?.id === 'a-1')
check('path: matches a human-typed bare path', pathDefinition.match(humanTypedPath)?.id === 'msg-9')
check('path: ignores prose mentioning path-like words', pathDefinition.match(assistantProseOnly) === null)
check('path: ignores the runtime-context snapshot', pathDefinition.match(runtimeContext) === null)
const pathState = pathDefinition.start({}, { event: assistantWithMarkdown })
check('path: collects markdown and standalone paths', JSON.stringify(pathState.paths) === JSON.stringify(['/Users/agent/shot.heic', '/tmp/plot.png']), pathState.paths)

// --- extraction rules in isolation
const extract = captured.__test.candidatePaths
check('extract: markdown with title', JSON.stringify(extract('![a](/x/y.webp "t")')) === '["/x/y.webp"]', extract('![a](/x/y.webp "t")'))
check('extract: angle-bracket markdown', JSON.stringify(extract('![a](</x/a b.png>)')) === '["/x/a b.png"]', extract('![a](</x/a b.png>)'))
check('extract: backticked standalone line', JSON.stringify(extract('see this\n\u0060/tmp/a.tiff\u0060\n')) === '["/tmp/a.tiff"]', extract('\u0060/tmp/a.tiff\u0060'))
check('extract: relative standalone line', JSON.stringify(extract('./out/chart.svg')) === '["./out/chart.svg"]', extract('./out/chart.svg'))
check('extract: windows path', JSON.stringify(extract('H:\\work\\shot.png')) === '["H:\\\\work\\\\shot.png"]', extract('H:\\work\\shot.png'))
check('extract: rejects a non-image extension', extract('/tmp/notes.txt').length === 0)
check('extract: rejects a bare filename with no separator', extract('shot.png').length === 0)
// Loose on purpose: "screenshot saved to /tmp/a.png" is exactly the sentence a
// preview should follow. The host route is the real filter.
check('extract: accepts an inline mention', JSON.stringify(extract('I wrote /tmp/a.png and moved on')) === '["/tmp/a.png"]', extract('I wrote /tmp/a.png and moved on'))
check('extract: rejects a token that continues past the extension', extract('src/app.png.ts changed').length === 0, extract('src/app.png.ts changed'))
check('extract: skips http(s) URLs', extract('see https://host/a.png for the asset').length === 0, extract('see https://host/a.png for the asset'))
check('extract: keeps a trailing-punctuation path', JSON.stringify(extract('saved to /tmp/b.webp.')) === '["/tmp/b.webp"]', extract('saved to /tmp/b.webp.'))
check('extract: dedupes and caps at six', extract(Array.from({ length: 20 }, (_unused, index) => '/tmp/' + String(index) + '.png').join('\n')).length === 6)
check('extract: survives empty and non-string input', extract('').length === 0 && extract(undefined).length === 0)

// --- rendering: attachment row
let seatProps
const seat = (props) => { seatProps = props; return jsxRuntime.jsx('div', { 'data-gallery': String(props.images.length) }) }
const attachmentHtml = renderToStaticMarkup(react.createElement(registrations.get('agent-image'), { node: attachmentNode, renderMessageImages: seat }))
check('attachment row uses the official seat', seatProps?.images.length === 1 && seatProps.align === 'start')
check('attachment row shows the file name', attachmentHtml.includes('tcr_shot.png'), attachmentHtml)
check('attachment row renders the gallery child', attachmentHtml.includes('data-gallery="1"'))

// --- rendering: path row (async probe, so wait a tick after the first render)
const PathRow = registrations.get('agent-image-path')
const pathNode = pathDefinition.buildViewNode({ key: 'k2', id: 'a-1', state: pathState, start: { location: { kind: 'step', turn: { turn: 2 }, step: { step: 1 } } }, matches: [] })
const firstPass = renderToStaticMarkup(react.createElement(PathRow, { node: pathNode, cwd: '/work', renderMessageImages: seat }))
check('path row renders nothing before the probe answers', firstPass === '', firstPass)
await new Promise((resolve) => setTimeout(resolve, 20))
const resolvedItems = await Promise.all(pathState.paths.map((path) => captured.__test.probePath(path, '/work')))
const good = resolvedItems.filter((entry) => entry !== null)
check('probe resolves both served paths', good.length === 2, resolvedItems)
check('probe builds a versioned file URL', good[0].preview.url === '/image-preview/file?path=' + encodeURIComponent('/Users/agent/shot.heic') + '&cwd=' + encodeURIComponent('/work') + '&v=99', good[0].preview.url)
check('probe carries dimensions into the gallery item', good[1].preview.width === 800 && good[1].preview.height === 600)
check('probe reports the transcode in meta', good[0].meta.transcoded === true && good[0].meta.format === 'heic')
const before = fetchCalls
await captured.__test.probePath('/Users/agent/shot.heic', '/work')
check('probe caches per path+cwd', fetchCalls === before, { before, after: fetchCalls })
const missing = await captured.__test.probePath('/tmp/does-not-exist.png', '')
check('probe returns null for a refused path', missing === null)

// --- degrade paths
const AttachmentRow = registrations.get('agent-image')
check('attachment row: no images -> nothing', AttachmentRow({ node: { data: { images: [], paths: [] } }, renderMessageImages: seat }) === null)
check('attachment row: missing seat -> nothing', AttachmentRow({ node: attachmentNode }) === null)
check('attachment row: malformed node -> nothing', AttachmentRow({ node: {} }) === null && AttachmentRow({}) === null)

console.log(failures.length === 0 ? '\nALL PASS' : '\n' + String(failures.length) + ' FAILING: ' + failures.join(', '))
process.exit(failures.length === 0 ? 0 : 1)
