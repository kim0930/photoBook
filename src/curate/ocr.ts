import { createWorker, type Worker } from 'tesseract.js'
import type { Photo } from '../types'

let workerPromise: Promise<Worker> | undefined

async function worker() {
  if (!workerPromise) {
    workerPromise = createWorker('kor+eng').catch((error) => {
      workerPromise = undefined
      throw error
    })
  }
  return workerPromise
}

export function documentCandidates(photos: Photo[]) {
  return photos.filter((photo) => photo.analysis?.documentCandidate && !photo.ocrText && !photo.forcedIn)
}

export async function readDocument(photo: Photo) {
  const blob = await fetch(photo.thumbUrl).then((response) => response.blob())
  const engine = await worker()
  const result = await engine.recognize(blob)
  const text = result.data.text.replace(/\s+/g, ' ').trim()
  return { text, document: text.length >= 40 || text.split(' ').filter((word) => word.length >= 2).length >= 8 }
}

export async function scanDocuments(photos: Photo[], onPhoto: (id: string, text: string, document: boolean) => void, onProgress?: (current: number, total: number) => void) {
  const targets = documentCandidates(photos)
  for (let index = 0; index < targets.length; index += 1) {
    onProgress?.(index + 1, targets.length)
    try {
      const read = await readDocument(targets[index])
      onPhoto(targets[index].id, read.text, read.document)
    } catch (error) {
      console.warn(`${targets[index].name}의 글자를 읽지 못했습니다.`, error)
    }
  }
}
