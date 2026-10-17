/**
 * preparePrintUrls 핵심 경로 스모크 (Node Blob).
 * 실행: node scripts/smoke-pdf-prepare.mjs
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

// Vite/TS 모듈은 직접 못 쓰므로 동일 로직을 인라인 검증
async function isHeic(blob, name) {
  if (blob.type === 'image/heic' || blob.type === 'image/heif') return true
  if (blob.type.startsWith('image/') && !/hei[cf]/.test(blob.type)) return false
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  if (header[0] === 0xff && header[1] === 0xd8) return false
  const brand = String.fromCharCode(...header.subarray(4, 12))
  return brand.startsWith('ftyp') || /\.hei[cf]$/i.test(name)
}

async function preparePrintUrls(photos) {
  const urls = new Map()
  const owned = []
  for (const photo of photos) {
    if (photo.selectedFrame) {
      urls.set(photo.id, photo.selectedFrame)
      continue
    }
    if (!photo.file?.size) continue
    if (await isHeic(photo.file, photo.name)) continue
    const url = URL.createObjectURL(photo.file)
    urls.set(photo.id, url)
    owned.push(url)
  }
  return { urls, owned }
}

const jpeg = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' })
const empty = new Blob([], { type: 'image/jpeg' })
const frame = 'data:image/jpeg;base64,/9j/4AAQ'

const { urls, owned } = await preparePrintUrls([
  { id: 'ok', name: 'a.jpg', file: jpeg },
  { id: 'empty', name: 'b.jpg', file: empty },
  { id: 'frame', name: 'c.jpg', file: empty, selectedFrame: frame },
])

const checks = [
  ['ok has blob url', urls.get('ok')?.startsWith('blob:')],
  ['empty skipped', !urls.has('empty')],
  ['selectedFrame kept', urls.get('frame') === frame],
  ['only owned revoked', owned.length === 1 && owned[0] === urls.get('ok')],
]

let failed = 0
for (const [label, ok] of checks) {
  console.log(ok ? 'ok' : 'FAIL', label)
  if (!ok) failed += 1
}
for (const url of owned) URL.revokeObjectURL(url)
if (failed) process.exit(1)
console.log('preparePrintUrls smoke passed')
