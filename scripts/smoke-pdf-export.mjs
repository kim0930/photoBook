/**
 * PDF 내보내기 E2E 스모크
 *   PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 \
 *   LD_LIBRARY_PATH=tmp/browser-libs/root/usr/lib/x86_64-linux-gnu \
 *   node scripts/smoke-pdf-export.mjs
 */
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outPdf = join(root, 'tmp', 'smoke-export.pdf')
const log = (...args) => {
  console.log(new Date().toISOString().slice(11, 19), ...args)
}

await mkdir(join(root, 'tmp'), { recursive: true })

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] })
log('browser up')
const page = await browser.newPage({ acceptDownloads: true })
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
page.on('dialog', async (d) => {
  logs.push(`[dialog] ${d.message()}`)
  await d.accept()
})

await page.goto(process.env.PHOTOBOOK_URL || 'http://127.0.0.1:5173/', {
  waitUntil: 'commit',
  timeout: 20_000,
})
log('loaded', page.url())
await page.waitForFunction(() => !!document.querySelector('#root')?.childElementCount, null, { timeout: 20_000 })
log('app mounted')

const seeded = await page.evaluate(async () => {
  const { useBookStore } = await import('/src/store.ts')
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 240
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#3d5a4c'
  ctx.fillRect(0, 0, 320, 240)
  ctx.fillStyle = '#fff'
  ctx.fillText('smoke', 20, 40)
  const file = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85))
  const photo = {
    id: 'smoke-one',
    name: 'smoke-one.jpg',
    file,
    url: URL.createObjectURL(file),
    thumbUrl: URL.createObjectURL(file),
    capturedAt: '2026-06-01T12:00:00.000Z',
    width: 320,
    height: 240,
    excluded: false,
  }
  useBookStore.getState().applyCuration([photo])
  const state = useBookStore.getState()
  return { pages: state.pages.length, photos: state.photos.length }
})
log('seeded', seeded)
if (!seeded.pages) throw new Error('시드 실패')

await page.waitForSelector('button:has-text("PDF 내보내기")', { timeout: 15_000 })
log('export button ready')

await page.evaluate(() => {
  window.__capturedPdf = null
  const orig = URL.createObjectURL.bind(URL)
  URL.createObjectURL = (obj) => {
    const url = orig(obj)
    if (obj instanceof Blob && (obj.type === 'application/pdf' || obj.size > 1500)) {
      if (!window.__capturedPdf || obj.size >= window.__capturedPdf.size) window.__capturedPdf = obj
    }
    return url
  }
})

await page.locator('button', { hasText: 'PDF 내보내기' }).first().click()
log('clicked export')

let info = null
for (let i = 0; i < 100; i += 1) {
  info = await page.evaluate(() => ({
    size: window.__capturedPdf?.size || 0,
    type: window.__capturedPdf?.type || '',
    label: [...document.querySelectorAll('button')]
      .map((b) => (b.textContent || '').trim())
      .find((t) => /PDF|원본|만드는|\d+\//.test(t)) || '',
    exportPages: document.querySelectorAll('[data-export-page]').length,
  }))
  if (i % 4 === 0) log('poll', i, info)
  if (info.size > 1000) break
  await page.waitForTimeout(400)
}

if (!(info?.size > 1000)) {
  await writeFile(join(root, 'tmp', 'smoke-pdf-logs.json'), JSON.stringify(logs.slice(-120), null, 2))
  await page.screenshot({ path: join(root, 'tmp', 'smoke-fail.png'), fullPage: true })
  throw new Error(`PDF 캡처 실패: ${JSON.stringify(info)}\n${logs.filter((l) => /error|dialog|실패|warn/i.test(l)).join('\n')}`)
}

const bytes = await page.evaluate(async () => Array.from(new Uint8Array(await window.__capturedPdf.arrayBuffer())))
await writeFile(outPdf, Buffer.from(bytes))
await browser.close()

const size = (await stat(outPdf)).size
const head = await readFile(outPdf)
if (head.subarray(0, 4).toString() !== '%PDF') throw new Error('PDF 헤더 없음')
log(`PASS ${outPdf} (${size} bytes)`)
