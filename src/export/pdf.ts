import { toJpeg } from 'html-to-image'
import { jsPDF } from 'jspdf'
import type { BookSize } from '../types'

export async function exportBookPdf(
  size: BookSize,
  orientation: 'portrait' | 'landscape',
  pageCount: number,
  onProgress: (current: number) => void,
) {
  const width = orientation === 'portrait' ? size.widthMm : size.heightMm
  const height = orientation === 'portrait' ? size.heightMm : size.widthMm
  const pdf = new jsPDF({ unit: 'mm', format: [width, height], orientation })

  for (let index = 0; index < pageCount; index += 1) {
    const node = document.querySelector<HTMLElement>(`[data-export-page="${index}"]`)
    if (!node) throw new Error(`${index + 1}페이지를 렌더링할 수 없습니다.`)
    if (index > 0) pdf.addPage([width, height], orientation)
    const image = await toJpeg(node, {
      quality: 0.95,
      pixelRatio: 300 / 96,
      cacheBust: true,
      backgroundColor: '#f8f5ef',
    })
    pdf.addImage(image, 'JPEG', 0, 0, width, height, undefined, 'FAST')
    onProgress(index + 1)
    await new Promise((resolve) => window.setTimeout(resolve, 0))
  }

  pdf.save(`photobook-${new Date().getFullYear()}.pdf`)
}
