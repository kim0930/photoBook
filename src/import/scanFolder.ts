import * as exifr from 'exifr'
import { analyzeBitmap } from '../classify/analyzePhoto'
import { persistPhotosBulk } from '../db'
import { quickHeicBitmap, renderHeicDisplay } from './heic'
import type { ImportProgress, Photo } from '../types'

const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|heic|heif)$/i
const MOVIE_EXTENSIONS = /\.(mov|mp4)$/i

function baseName(name: string) {
  return name.replace(/\.[^.]+$/, '').toLowerCase()
}

/** 보관함·배치용 미리보기. 원본은 별도 저장하므로 크게 둘 필요 없음 */
const THUMB_EDGE = 480
/** JPEG/PNG는 병렬로, HEIC는 libheif 잠금 때문에 사실상 순차 */
const IMPORT_CONCURRENCY = 6
const DATE_CONCURRENCY = 16
const YEAR_SAMPLE_LIMIT = 48
const PERSIST_BATCH = 12

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
    ? { resizeWidth: maxEdge, resizeQuality: 'low' }
    : { resizeHeight: maxEdge, resizeQuality: 'low' }
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
    2_500,
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

async function detectYearFromSample(
  images: File[],
  onProgress: (progress: ImportProgress) => void,
): Promise<{ year?: number; skips: ImportSkip[] }> {
  const step = Math.max(1, Math.ceil(images.length / YEAR_SAMPLE_LIMIT))
  const sample = images.length <= YEAR_SAMPLE_LIMIT
    ? images
    : images.filter((_, index) => index % step === 0).slice(0, YEAR_SAMPLE_LIMIT)

  onProgress({ current: 0, total: sample.length, label: '촬영 연도 확인 중' })
  const dates: Date[] = []
  const skips: ImportSkip[] = []
  let done = 0
  await mapLimit(sample, DATE_CONCURRENCY, async (file) => {
    const capturedAt = await readCaptureDate(file)
    if (capturedAt) dates.push(capturedAt)
    else skips.push({ name: file.name, reason: '촬영일을 읽지 못함' })
    done += 1
    onProgress({ current: done, total: sample.length, label: '촬영 연도 확인 중' })
  })
  return { year: dominantYear(dates), skips }
}

/** 가벼운 날짜 읽기만으로 해당 연도 파일만 추린다 (디코드 없음). */
async function filterByYear(
  images: File[],
  year: number,
  onProgress: (progress: ImportProgress) => void,
): Promise<{ targets: Array<{ file: File; capturedAt: Date }>; skips: ImportSkip[] }> {
  onProgress({ current: 0, total: images.length, label: `${year}년 사진 고르는 중` })
  const targets: Array<{ file: File; capturedAt: Date }> = []
  const skips: ImportSkip[] = []
  let done = 0
  await mapLimit(images, DATE_CONCURRENCY, async (file) => {
    const capturedAt = await readCaptureDate(file)
    if (!capturedAt) skips.push({ name: file.name, reason: '촬영일을 읽지 못함' })
    else if (capturedAt.getFullYear() !== year) {
      skips.push({ name: file.name, reason: `${year}년이 아님 (${capturedAt.getFullYear()}년)` })
    } else {
      targets.push({ file, capturedAt })
    }
    done += 1
    if (done % 4 === 0 || done === images.length) {
      onProgress({ current: done, total: images.length, label: `${year}년 사진 고르는 중` })
    }
  })
  return { targets, skips }
}

export type ImportSkip = { name: string; reason: string }
export type ScanResult = { photos: Photo[]; skips: ImportSkip[]; year?: number }

/** year를 주면 그해만, 없으면 폴더 샘플에서 가장 많은 촬영 연도를 골라 가져온다. */
export async function scanFiles(
  files: File[],
  onProgress: (progress: ImportProgress) => void,
  options?: { year?: number },
): Promise<ScanResult> {
  const images = files.filter((file) => IMAGE_EXTENSIONS.test(file.name))
  const movies = new Map(
    files
      .filter((file) => MOVIE_EXTENSIONS.test(file.name))
      .map((file) => [baseName(file.name), file]),
  )
  const photos: Photo[] = []
  const skips: ImportSkip[] = []
  if (!images.length) {
    for (const file of files) {
      if (!IMAGE_EXTENSIONS.test(file.name) && !MOVIE_EXTENSIONS.test(file.name)) {
        skips.push({ name: file.name, reason: '지원하지 않는 형식' })
      }
    }
    return { photos, skips }
  }

  let year = options?.year
  if (year == null) {
    const detected = await detectYearFromSample(images, onProgress)
    skips.push(...detected.skips)
    year = detected.year
  }
  if (year == null) return { photos, skips, year }

  const filtered = await filterByYear(images, year, onProgress)
  skips.push(...filtered.skips)
  const targets = filtered.targets
  if (!targets.length) return { photos, skips, year }

  let finished = 0
  const pending: Array<{ photo: Photo; thumbnail: Blob; displayBlob: Blob }> = []
  let flushChain: Promise<void> = Promise.resolve()

  function flushPending(force = false) {
    flushChain = flushChain.then(async () => {
      if (!pending.length) return
      if (!force && pending.length < PERSIST_BATCH) return
      const batch = pending.splice(0, pending.length)
      await persistPhotosBulk(batch)
    })
    return flushChain
  }

  onProgress({ current: 0, total: targets.length, label: `${year}년 사진 준비 중` })

  await mapLimit(targets, IMPORT_CONCURRENCY, async ({ file, capturedAt }) => {
    try {
      const metadata = await withTimeout(
        exifr.parse(file, {
          pick: ['GPSLatitude', 'GPSLongitude', 'Orientation', 'ExifImageWidth', 'ExifImageHeight', 'ImageWidth', 'ImageHeight'],
          translateValues: false,
        }),
        4_000,
        `${file.name} 메타데이터`,
      ).catch(() => undefined)

      const known = orientedSize(metadata)
      const heic = /\.hei[cf]$/i.test(file.name)
      const decodeSize = known.width && known.height ? known : { width: THUMB_EDGE + 1, height: 1 }
      const decoded = heic
        ? await heicBitmap(file)
        : {
            bitmap: await withTimeout(nativeBitmap(file, THUMB_EDGE, decodeSize), 8_000, file.name),
            thumbnail: undefined as Blob | undefined,
          }
      const bitmap = decoded.bitmap
      let thumbnail = decoded.thumbnail
      let analysis: Photo['analysis']
      let width = known.width || bitmap.width
      let height = known.height || bitmap.height
      try {
        // 이미 디코드한 비트맵으로 장면·중요도를 뽑아 자동 배치에 쓴다.
        try {
          analysis = analyzeBitmap(bitmap)
        } catch (error) {
          console.warn(`${file.name}의 장면 분석을 건너뜁니다.`, error)
        }
        if (!thumbnail) thumbnail = await bitmapToBlob(bitmap, THUMB_EDGE, 0.72)
      } finally {
        bitmap.close()
      }
      if (!thumbnail) throw new Error('썸네일을 만들지 못했습니다.')

      const movie = movies.get(baseName(file.name))
      const automaticSize = analysis && analysis.importance > 0.72
        ? 'large'
        : analysis && analysis.importance < 0.38
          ? 'small'
          : 'medium'
      const thumbUrl = URL.createObjectURL(thumbnail)
      const photo: Photo = {
        id: `${file.name}-${file.size}-${file.lastModified}`,
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
      pending.push({ photo, thumbnail, displayBlob: file })
      await flushPending()
    } catch (error) {
      const reason = error instanceof Error ? error.message : '처리 실패'
      skips.push({ name: file.name, reason })
      console.warn(`${file.name} 파일을 건너뜁니다.`, error)
    } finally {
      finished += 1
      onProgress({ current: finished, total: targets.length, label: `${year}년 사진 준비 중` })
    }
  })

  await flushPending(true)

  return {
    photos: photos.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt)),
    skips,
    year,
  }
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
