import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const dir = join(import.meta.dirname, 'fixtures')
const png = readFileSync(join(dir, 'base.png'))
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)   // type 1 = icon
header.writeUInt16LE(1, 4)   // one image
const entry = Buffer.alloc(16)
entry[0] = 64                // width
entry[1] = 40                // height
entry.writeUInt16LE(1, 4)    // color planes
entry.writeUInt16LE(32, 6)   // bit depth
entry.writeUInt32LE(png.length, 8)
entry.writeUInt32LE(22, 12)  // offset
writeFileSync(join(dir, 'sample.ico'), Buffer.concat([header, entry, png]))
console.log('wrote sample.ico')
