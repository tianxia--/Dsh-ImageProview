// Checks every dsh runtime contract this plugin relies on against the dsh that
// is actually installed. None of these packages is imported (services arrive
// through cordis inject), so neither a static scanner nor dsh's peer check can
// see a broken contract. Run after every dsh upgrade:  npm run check:dsh
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

function dshPackagesDir() {
  if (process.env.DSH_PACKAGES !== undefined) return process.env.DSH_PACKAGES
  const bin = execSync('command -v dsh', { shell: '/bin/sh' }).toString().trim()
  let dir = dirname(realpathSync(bin))
  while (dir !== '/' && !existsSync(join(dir, 'package.json'))) dir = dirname(dir)
  return join(dir, 'node_modules', '@deepseek-ai')
}

const base = dshPackagesDir()
const read = (pkg, file) => { try { return readFileSync(join(base, pkg, 'lib', file), 'utf8') } catch { return '' } }
const version = (pkg) => { try { return JSON.parse(readFileSync(join(base, pkg, 'package.json'), 'utf8')).version } catch { return 'missing' } }

const chat = read('dsh-client-ui-chat', 'client.js')
const conversation = read('dsh-client-ui-conversation', 'client.js')
const attachment = read('dsh-client-ui-attachment', 'client.js')
const slotHosts = ['dsh-client-ui-renderer', 'dsh-client-runtime'].map((pkg) => read(pkg, 'client.js'))
const web = read('dsh-host-webserver', 'index.js')
const contextView = (() => { const at = chat.indexOf('const ContextMessageNodeView'); return at < 0 ? '' : chat.slice(at, at + 700) })()

const checks = [
  ['ui-chat: a non-human user/message becomes a context node', /source\.kind !== "user"\)/.test(chat) && /kind: "context"/.test(chat)],
  ['ui-chat: the context row has no image seat (else rows would duplicate)', contextView !== '' && !contextView.includes('renderMessageImages')],
  ['ui-chat: every node renderer receives renderMessageImages', /const owner = [\s\S]{0,300}renderMessageImages/.test(chat)],
  ['ui-chat: every node renderer receives cwd', /const owner = [\s\S]{0,200}\bcwd\b/.test(chat)],
  ['ui-chat: the keyed node seat dispatches on node.kind', /renderSlot\("conversation\.chat\.node", routedOwner, \{\s*entryKey: routedNode\.kind/.test(chat)],
  ['ui-chat: renderMessageImages renders conversation.message.images', chat.includes('renderSlot("conversation.message.images"')],
  ['ui-conversation: events.register(definition)', /register\(definition\) \{\s*assertDefinitionTarget/.test(conversation)],
  ['ui-conversation: Definitions are not exclusive', /for \(const definition of this\.eventDefinitions\.entries\(\)\) \{\s*const result = definition\.match\(event\);\s*if \(result === null\) continue;/.test(conversation)],
  ['ui-attachment: the gallery accepts { attachment } items', attachment.includes('"attachment" in image')],
  ['ui-attachment: the gallery accepts { preview } items', attachment.includes('"preview" in image')],
  ['ui-attachment: it fills conversation.message.images', attachment.includes('ctx.slots.inject("conversation.message.images"')],
  ['slots: a SlotRegistry is installed (renderer on 0.2.x, runtime on 0.1.x)', slotHosts.some((code) => code.includes('SlotRegistry.prototype.register = function register('))],
  ['host-webserver: exact routes can be registered', web.includes('"exact"')],
]

let failed = 0
for (const [name, ok] of checks) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name)
  if (!ok) failed += 1
}
console.log('\ndsh packages: ' + base)
console.log('versions: ' + ['dsh-client-ui-chat', 'dsh-client-ui-conversation', 'dsh-client-ui-attachment', 'dsh-client-ui-renderer', 'dsh-host-webserver'].map((pkg) => pkg.replace('dsh-', '') + '@' + version(pkg)).join('  '))
console.log(failed === 0 ? '\nALL CONTRACTS HOLD' : '\n' + String(failed) + ' CONTRACT(S) CHANGED - do not widen peerDependencies before fixing')
process.exit(failed === 0 ? 0 : 1)
