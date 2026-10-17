import * as exifr from 'exifr'
import { analyzeBitmap } from '../classify/analyzePhoto'
import { persistPhoto } from '../db'
import { quickHeicBitmap, renderHeicDisplay } from './heic'
import type { ImportProgress, Photo } from '../types'

const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|heic|heif)$/i
const MOVIE_EXTENSIONS = /\.(mov|mp4)$/i

function baseName(name: string) {
  return name.replace(/\.[^.]+$/, '').toLowerCase()
}

const THUMB_EDGE = 640
const IMPORT_CONCURRENCY = 3

function positive(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function orientedSize(metadata?: Record<string, unknown>) {
  let width = positive(metadata?.ExifImageWidth ?? metadata?.ImageWidth)
  let height = positive(metadata?.ExifImageHeight ?? metadata?.ImageHeight)
  const orientation = positive(metadata?.Orientation)
  if (orientation >= 5 && width && height) [width, height] = [height, width]
  return { width, height }
}

function resizeOptions(width: number, height: number, maxEdge: number): ImageBitmapOptions | undefined {
  const longest = Math.max(width, height)
  if (!width || !height || longest <= maxEdge) return undefined
  return width >= height
    ? { resizeWidth: maxEdge, resizeQuality: 'medium' }
    : { resizeHeight: maxEdge, resizeQuality: 'medium' }
}

async function bitmapToBlob(bitmap: ImageBitmap, maxEdge: number, quality: number) {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(bitmap.width * scale)),
    Math.max(1, Math.round(bitmap.height * scale)),
  )
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('이미지를 처리할 수 없습니다.')
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas.convertToBlob({ type: 'image/jpeg', quality })
}

async function nativeBitmap(file: File, maxEdge: number, known: { width: number; height: number }) {
  const options = resizeOptions(known.width, known.height, maxEdge)
  if (options) {
    try {
      return await createImageBitmap(file, options)
    } catch (error) {
      if (!/\.hei[cf]$/i.test(file.name)) throw error
    }
  }
  return createImageBitmap(file)
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`${label} 시간 초과`)), ms)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** HEIC는 브라우저 native 디코더가 멈추는 경우가 있어 libheif만 사용한다. */
async function heicBitmap(file: File) {
  const quick = await quickHeicBitmap(file).catch(() => undefined)
  if (quick) return { bitmap: quick, thumbnail: undefined as Blob | undefined }
  // libheif는 직렬 실행이라 대기 시간이 길 수 있다. 실제 디코드만 제한한다.
  const rendered = await withTimeout(renderHeicDisplay(file), 45_000, file.name)
  const bitmap = await createImageBitmap(rendered.thumbnail)
  return { bitmap, thumbnail: rendered.thumbnail }
}

async function mapLimit<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  let cursor = 0
  async function run() {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      await worker(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()))
}

async function readCaptureDate(file: File) {
  const metadata = await withTimeout(
    exifr.parse(file, {
      pick: ['DateTimeOriginal', 'CreateDate'],
      translateValues: false,
    }),
    5_000,
    `${file.name} 날짜`,
  ).catch(() => undefined)
  const captured = metadata?.DateTimeOriginal ?? metadata?.CreateDate ?? new Date(file.lastModified)
  const capturedAt = new Date(captured)
  return Number.isNaN(capturedAt.getTime()) ? undefined : capturedAt
}

function dominantYear(dates: Date[]) {
  const counts = new Map<number, number>()
  for (const date of dates) {
    const year = date.getFullYear()
    counts.set(year, (counts.get(year) ?? 0) + 1)
  }
  if (!counts.size) return undefined
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0]
}

/** year를 주면 그해만, 없으면 폴더에서 가장 많은 촬영 연도를 골라 가져온다. */
export async function scanFiles(
  files: File[],
  onProgress: (progress: ImportProgress) => void,
  options?: { year?: number },
): Promise<Photo[]> {
  const images = files.filter((file) => IMAGE_EXTENSIONS.test(file.name))
  const movies = new Map(
    files
      .filter((file) => MOVIE_EXTENSIONS.test(file.name))
      .map((file) => [baseName(file.name), file]),
  )
  const photos: Photo[] = []
  if (!images.length) return photos

  onProgress({ current: 0, total: images.length, label: '촬영 연도를 확인하는 중' })
  const dated: Array<{ file: File; capturedAt: Date }> = []
  let datedDone = 0
  await mapLimit(images, Math.min(8, IMPORT_CONCURRENCY * 2), async (file) => {
    const capturedAt = await readCaptureDate(file)
    if (capturedAt) dated.push({ file, capturedAt })
    datedDone += 1
    onProgress({ current: datedDone, total: images.length, label: '촬영 연도를 확인하는 중' })
  })

  const year = options?.year ?? dominantYear(dated.map((item) => item.capturedAt))
  if (year == null) return photos
  const targets = dated.filter((item) => item.capturedAt.getFullYear() === year).map((item) => item.file)
  if (!targets.length) return photos

  let finished = 0
  onProgress({ current: 0, total: targets.length, label: `${year}년 사진을 준비하는 중` })

  await mapLimit(targets, IMPORT_CONCURRENCY, async (file) => {
    onProgress({ current: finished, total: targets.length, label: `${file.name} 준비 중` })
    try {
      const metadata = await withTimeout(
        exifr.parse(file, {
          pick: ['DateTimeOriginal', 'CreateDate', 'GPSLatitude', 'GPSLongitude', 'Orientation', 'ExifImageWidth', 'ExifImageHeight', 'ImageWidth', 'ImageHeight'],
          translateValues: false,
        }),
        5_000,
        `${file.name} 메타데이터`,
      ).catch(() => undefined)
      const captured = metadata?.DateTimeOriginal ?? metadata?.CreateDate ?? new Date(file.lastModified)
      const capturedAt = new Date(captured)
      if (Number.isNaN(capturedAt.getTime()) || capturedAt.getFullYear() !== year) return

      const known = orientedSize(metadata)
      const heic = /\.hei[cf]$/i.test(file.name)
      const decodeSize = known.width && known.height ? known : { width: THUMB_EDGE + 1, height: 1 }
      const decoded = heic
        ? await heicBitmap(file)
        : { bitmap: await withTimeout(nativeBitmap(file, THUMB_EDGE, decodeSize), 10_000, file.name), thumbnail: undefined as Blob | undefined }
      const bitmap = decoded.bitmap
      let thumbnail = decoded.thumbnail
      let analysis: Photo['analysis']
      let width = known.width
      let height = known.height
      const id = `${file.name}-${file.size}-${file.lastModified}`
      try {
        width = width || bitmap.width
        height = height || bitmap.height
        try {
          analysis = analyzeBitmap(bitmap)
        } catch (error) {
          console.warn(`${file.name}의 장면 분석을 건너뜁니다.`, error)
        }
        if (!thumbnail) thumbnail = await bitmapToBlob(bitmap, THUMB_EDGE, 0.82)
      } finally {
        bitmap.close()
      }
      if (!thumbnail) throw new Error('썸네일을 만들지 못했습니다.')

      const movie = movies.get(baseName(file.name))
      const automaticSize = analysis && analysis.importance > 0.72 ? 'large' : analysis && analysis.importance < 0.38 ? 'small' : 'medium'
      const thumbUrl = URL.createObjectURL(thumbnail)
      const photo: Photo = {
        id,
        name: file.name,
        file,
        movie,
        url: thumbUrl,
        thumbUrl,
        capturedAt: capturedAt.toISOString(),
        width,
        height,
        latitude: metadata?.latitude ?? metadata?.GPSLatitude,
        longitude: metadata?.longitude ?? metadata?.GPSLongitude,
        size: automaticSize,
        layoutWeight: automaticSize === 'large' ? 1.7 : automaticSize === 'small' ? 0.65 : 1,
        isLive: Boolean(movie),
        analysis,
      }
      photos.push(photo)
      await persistPhoto(photo, thumbnail, file)
    } catch (error) {
      console.warn(`${file.name} 파일을 건너뜁니다.`, error)
    } finally {
      finished += 1
      onProgress({ current: finished, total: targets.length, label: file.name })
    }
  })

  return photos.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
}

export async function chooseDirectoryFiles(onCount?: (count: number) => void): Promise<File[]> {
  const picker = (window as Window & {
    showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>
  }).showDirectoryPicker
  if (!picker) throw new Error('FALLBACK_INPUT')
  const root = await picker()
  const files: File[] = []

  async function walk(directory: FileSystemDirectoryHandle) {
    for await (const handle of directory.values()) {
      if (handle.kind === 'file') {
        files.push(await handle.getFile())
        if (files.length % 20 === 0) onCount?.(files.length)
      } else await walk(handle)
    }
  }
  await walk(root)
  onCount?.(files.length)
  return files
}
