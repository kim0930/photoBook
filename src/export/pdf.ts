import { toJpeg } from 'html-to-image'
import { jsPDF } from 'jspdf'
import { renderHeicDisplay } from '../import/heic'
import { coverSpread } from '../settings/bookSize'
import type { BookSize, Photo } from '../types'

async function isHeic(blob: Blob, name: string) {
  if (blob.type === 'image/heic' || blob.type === 'image/heif') return true
  if (blob.type.startsWith('image/') && !/hei[cf]/.test(blob.type)) return false
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  if (header[0] === 0xff && header[1] === 0xd8) return false
  const brand = String.fromCharCode(...header.subarray(4, 12))
  return brand.startsWith('ftyp') || /\.hei[cf]$/i.test(name)
}

export type PreparedPrintUrls = {
  urls: Map<string, string>
  /** createObjectURL로 만든 값만 — selectedFrame 등은 revoke하지 않음 */
  owned: string[]
}

export async function preparePrintUrls(photos: Photo[], onProgress: (label: string) => void): Promise<PreparedPrintUrls> {
  const urls = new Map<string, string>()
  const owned: string[] = []
  const heic: Photo[] = []

  for (const photo of photos) {
    if (photo.selectedFrame) {
      urls.set(photo.id, photo.selectedFrame)
      continue
    }
    if (!photo.file?.size) continue
    if (await isHeic(photo.file, photo.name)) heic.push(photo)
    else {
      const url = URL.createObjectURL(photo.file)
      urls.set(photo.id, url)
      owned.push(url)
    }
  }

  for (let index = 0; index < heic.length; index += 1) {
    onProgress(`원본 준비 ${index + 1}/${heic.length}`)
    try {
      const rendered = await renderHeicDisplay(heic[index].file)
      const url = URL.createObjectURL(rendered.display)
      urls.set(heic[index].id, url)
      owned.push(url)
    } catch (error) {
      console.warn(`${heic[index].name} 원본 변환을 건너뜁니다.`, error)
    }
  }

  return { urls, owned }
}

export function revokePrintUrls(urls: Iterable<string>) {
  for (const url of urls) {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url)
  }
}

export function waitForExportImages(timeoutMs = 12000) {
  const images = [...document.querySelectorAll<HTMLImageElement>('.export-stage img')]
  return Promise.all(images.map((image) => (
    image.complete && image.naturalWidth
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          const done = () => {
            window.clearTimeout(timer)
            resolve()
          }
          const timer = window.setTimeout(done, timeoutMs)
          image.addEventListener('load', done, { once: true })
          image.addEventListener('error', done, { once: true })
        })
  )))
}

export async function exportBookPdf(
  size: BookSize,
  orientation: 'portrait' | 'landscape',
  pageCount: number,
  onProgress: (current: number) => void,
) {
  if (!pageCount) throw new Error('내보낼 페이지가 없습니다.')

  const spread = coverSpread(size, orientation, pageCount)
  const jacket = document.querySelector<HTMLElement>('[data-export-page="jacket"]')
  const pdf = new jsPDF({
    unit: 'mm',
    format: jacket ? [spread.spreadMm, spread.heightMm] : [spread.widthMm, spread.heightMm],
    orientation: jacket ? 'p' : orientation,
  })
  let placed = false
  const paint = async (node: HTMLElement, pageWidth: number, pageHeight: number, nextOrientation: 'portrait' | 'landscape' | 'p') => {
    if (placed) pdf.addPage([pageWidth, pageHeight], nextOrientation)
    placed = true
    const image = await toJpeg(node, {
      quality: 0.95,
      pixelRatio: Math.min(2.5, 220 / 96),
      // blob: URL에 쿼리를 붙이면 ERR_FILE_NOT_FOUND로 캡처가 실패함
      cacheBust: false,
      backgroundColor: '#f8f5ef',
      filter: (element) => {
        if (!(element instanceof HTMLElement)) return true
        return !element.classList.contains('leaflet-control-container')
          && !element.classList.contains('page-map-tools')
      },
    })
    pdf.addImage(image, 'JPEG', 0, 0, pageWidth, pageHeight, undefined, 'FAST')
    await new Promise((resolve) => window.setTimeout(resolve, 0))
  }
  if (jacket) await paint(jacket, spread.spreadMm, spread.heightMm, 'p')

  for (let index = 0; index < pageCount; index += 1) {
    const node = document.querySelector<HTMLElement>(`[data-export-page="${index}"]`)
    if (!node) throw new Error(`${index + 1}페이지를 렌더링할 수 없습니다.`)
    await paint(node, spread.widthMm, spread.heightMm, orientation)
    onProgress(index + 1)
  }

  if (!placed) throw new Error('PDF에 넣을 페이지를 찾지 못했습니다.')
  pdf.save(`photobook-${new Date().getFullYear()}.pdf`)
}
