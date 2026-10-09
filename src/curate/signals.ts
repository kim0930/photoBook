import type { ExcludeReason, Photo } from '../types'

const BURST_GAP_MS = 8000
const HASH_DISTANCE = 18
const EVENT_GAP_MS = 6 * 60 * 60 * 1000
const EVENT_MOVE_KM = 30
const EARTH_RADIUS_KM = 6371

export function scoreQuality(photo: Photo) {
  const sharpness = photo.analysis?.sharpness ?? 0.45
  const brightness = photo.analysis?.brightness ?? 0.5
  const exposure = 1 - Math.min(1, Math.abs(brightness - 0.52) * 2.2)
  const importance = photo.analysis?.importance ?? 0.4
  let score = sharpness * 0.42 + exposure * 0.28 + importance * 0.3
  if (photo.faceQuality != null) score = score * 0.72 + photo.faceQuality * 0.28
  return clamp(score)
}

export const SIGNALS_VERSION = 2

export function signalExclude(photo: Photo): ExcludeReason | undefined {
  const name = photo.name.toLowerCase()
  if (/screenshot|screen[-_ ]?shot|screencapture|스크린샷|화면.?캡처/.test(name)) return 'screenshot'
  const longest = Math.max(photo.width || 0, photo.height || 0)
  const shortest = Math.min(photo.width || 0, photo.height || 0)
  const ratio = shortest ? longest / shortest : 1
  const noPlace = photo.latitude == null || photo.longitude == null
  if (/\.png$/i.test(photo.name) && noPlace && ratio >= 1.85) return 'screenshot'
  if (longest > 0 && longest < 720) return 'lowres'
  const sharpness = photo.analysis?.sharpness
  const brightness = photo.analysis?.brightness
  if (sharpness != null && sharpness < 0.15) return 'blur'
  if (brightness != null && (brightness < 0.08 || brightness > 0.96)) return 'blur'
  return undefined
}

export function assignBursts(photos: Photo[]) {
  const sorted = [...photos].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id))
  const bursts: Photo[][] = []
  for (const photo of sorted) {
    const current = bursts.at(-1)
    const previous = current?.at(-1)
    const gap = previous ? new Date(photo.capturedAt).getTime() - new Date(previous.capturedAt).getTime() : Infinity
    const hashes = previous?.thumbHash && photo.thumbHash ? hammingHex(previous.thumbHash, photo.thumbHash) : 0
    const limit = gap <= 1500 ? 28 : HASH_DISTANCE
    const different = Boolean(previous?.thumbHash && photo.thumbHash && hashes > limit)
    if (!current || gap > BURST_GAP_MS || gap < 0 || different) bursts.push([photo])
    else current.push(photo)
  }
  const byId = new Map<string, { burstId: string; burstBest: boolean; excludeReason?: ExcludeReason }>()
  bursts.forEach((group, index) => {
    const burstId = `burst-${index}`
    const best = [...group].sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0) || a.id.localeCompare(b.id))[0]
    for (const photo of group) {
      const duplicate = group.length > 1 && photo.id !== best.id && !photo.forcedIn && !photo.excludeReason
      byId.set(photo.id, {
        burstId,
        burstBest: photo.id === best.id,
        excludeReason: duplicate ? 'duplicate' : photo.excludeReason,
      })
    }
  })
  return byId
}

export function assignEvents(photos: Photo[]) {
  const sorted = [...photos].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.id.localeCompare(b.id))
  const ids = new Map<string, string>()
  let eventIndex = 0
  let previous: Photo | undefined
  for (const photo of sorted) {
    if (previous && (timeGap(previous, photo) > EVENT_GAP_MS || moved(previous, photo))) eventIndex += 1
    ids.set(photo.id, `event-${eventIndex}`)
    previous = photo
  }
  return ids
}

export async function curatePhotos(photos: Photo[], onProgress?: (current: number, total: number) => void) {
  const total = photos.length
  const hashed: Photo[] = []
  for (let index = 0; index < photos.length; index += 1) {
    const photo = photos[index]
    let thumbHash = photo.thumbHash
    if (!thumbHash && photo.thumbUrl) {
      try {
        const blob = await fetch(photo.thumbUrl).then((response) => response.blob())
        thumbHash = await averageHash(blob)
      } catch (error) {
        console.warn(`${photo.name}의 연사 비교를 건너뜁니다.`, error)
      }
    }
    const quality = scoreQuality({ ...photo })
    const keepDocument = photo.excludeReason === 'document' && !photo.forcedIn
    const excludeReason = photo.forcedIn ? undefined : keepDocument ? 'document' : signalExclude(photo)
    hashed.push({ ...photo, thumbHash, quality, excludeReason, holdReason: undefined })
    onProgress?.(index + 1, total)
  }
  const bursts = assignBursts(hashed)
  const events = assignEvents(hashed)
  return hashed.map((photo) => {
    const burst = bursts.get(photo.id)
    return {
      ...photo,
      burstId: burst?.burstId,
      burstBest: burst?.burstBest,
      excludeReason: burst?.excludeReason,
      eventId: events.get(photo.id),
    }
  })
}

export async function averageHash(blob: Blob) {
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = 8
    canvas.height = 8
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return undefined
    context.drawImage(bitmap, 0, 0, 8, 8)
    const data = context.getImageData(0, 0, 8, 8).data
    const levels: number[] = []
    for (let index = 0; index < data.length; index += 4) {
      levels.push(data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114)
    }
    const mean = levels.reduce((sum, level) => sum + level, 0) / levels.length
    const bits = levels.map((level) => (level >= mean ? '1' : '0')).join('')
    return BigInt(`0b${bits}`).toString(16).padStart(16, '0')
  } finally {
    bitmap.close()
  }
}

export function hammingHex(a: string, b: string) {
  let value = BigInt(`0x${a}`) ^ BigInt(`0x${b}`)
  let count = 0
  while (value) {
    count += Number(value & 1n)
    value >>= 1n
  }
  return count
}

function timeGap(previous: Photo, photo: Photo) {
  return new Date(photo.capturedAt).getTime() - new Date(previous.capturedAt).getTime()
}

function moved(previous: Photo, photo: Photo) {
  if (previous.latitude == null || previous.longitude == null || photo.latitude == null || photo.longitude == null) return false
  return distanceKm([previous.latitude, previous.longitude], [photo.latitude, photo.longitude]) > EVENT_MOVE_KM
}

function distanceKm(a: [number, number], b: [number, number]) {
  const rad = Math.PI / 180
  const dLat = (b[0] - a[0]) * rad
  const dLon = (b[1] - a[1]) * rad
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(x))
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, value))
}
