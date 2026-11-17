import type { Chapter, Photo } from '../types'

const EARTH_RADIUS_KM = 6371
let lastNominatimRequest = 0

function distanceKm(a: [number, number], b: [number, number]) {
  const rad = Math.PI / 180
  const dLat = (b[0] - a[0]) * rad
  const dLon = (b[1] - a[1]) * rad
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(x))
}

function dateKey(photo: Photo) {
  return photo.capturedAt.slice(0, 10)
}

function monthOf(photo: Photo | undefined) {
  if (!photo) return 0
  const date = new Date(photo.capturedAt)
  return Number.isNaN(date.getTime()) ? 0 : date.getMonth() + 1
}

function estimateHome(photos: Photo[]): [number, number] | undefined {
  const buckets = new Map<string, { lat: number; lon: number; count: number }>()
  for (const photo of photos) {
    if (photo.latitude == null || photo.longitude == null) continue
    const key = `${photo.latitude.toFixed(1)},${photo.longitude.toFixed(1)}`
    const bucket = buckets.get(key) ?? { lat: photo.latitude, lon: photo.longitude, count: 0 }
    bucket.count += 1
    buckets.set(key, bucket)
  }
  const home = [...buckets.values()].sort((a, b) => b.count - a.count)[0]
  return home ? [home.lat, home.lon] : undefined
}

export function cachedPlace(lat: number, lon: number) {
  return localStorage.getItem(`place:${lat.toFixed(2)},${lon.toFixed(2)}`) ?? ''
}

export async function placeName(lat: number, lon: number): Promise<string> {
  const cacheKey = `place:${lat.toFixed(2)},${lon.toFixed(2)}`
  const cached = localStorage.getItem(cacheKey)
  if (cached) return cached
  try {
    const wait = Math.max(0, 1000 - (Date.now() - lastNominatimRequest))
    if (wait) await new Promise((resolve) => window.setTimeout(resolve, wait))
    lastNominatimRequest = Date.now()
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=8&accept-language=ko`,
    )
    const json = await response.json()
    const name =
      json.address?.city ?? json.address?.county ?? json.address?.state ?? json.display_name?.split(',')[0]
    if (name) localStorage.setItem(cacheKey, name)
    return name || '여행'
  } catch {
    return '여행'
  }
}

function tripPhotoIds(chapters: Chapter[]) {
  const ids = new Set<string>()
  for (const chapter of chapters) {
    if (chapter.type !== 'trip') continue
    for (const id of chapter.photoIds) ids.add(id)
  }
  return ids
}

function chapterMonth(chapter: Chapter, photosById: Map<string, Photo>) {
  if (chapter.type === 'month' && chapter.month) return chapter.month
  if (chapter.month) return chapter.month
  return monthOf(photosById.get(chapter.photoIds[0]))
}

function sortChapters(chapters: Chapter[], photos: Photo[]) {
  const photosById = new Map(photos.map((photo) => [photo.id, photo]))
  return [...chapters].sort((a, b) => {
    const aMonth = chapterMonth(a, photosById)
    const bMonth = chapterMonth(b, photosById)
    if (aMonth !== bMonth) return aMonth - bMonth
    // 같은 달: 월 챕터 → 여행 챕터
    if (a.type !== b.type) return a.type === 'month' ? -1 : 1
    const aDate = photosById.get(a.photoIds[0])?.capturedAt ?? ''
    const bDate = photosById.get(b.photoIds[0])?.capturedAt ?? ''
    return aDate.localeCompare(bDate)
  })
}

export async function buildChapters(photos: Photo[], thresholdKm = 50): Promise<Chapter[]> {
  const home = estimateHome(photos)
  const away = home
    ? photos
        .filter(
          (p) =>
            p.latitude != null
            && p.longitude != null
            && distanceKm(home, [p.latitude, p.longitude]) >= thresholdKm,
        )
        .sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
    : []

  const tripGroups: Photo[][] = []
  for (const photo of away) {
    const current = tripGroups.at(-1)
    const previous = current?.at(-1)
    const dayGap = previous
      ? (new Date(dateKey(photo)).getTime() - new Date(dateKey(previous)).getTime()) / 86_400_000
      : Infinity
    if (!current || dayGap > 2) tripGroups.push([photo])
    else current.push(photo)
  }

  const trips = await Promise.all(
    tripGroups.map(async (group, index) => {
      const first = group[0]
      const last = group.at(-1)!
      const destination =
        first.latitude != null && first.longitude != null
          ? await placeName(first.latitude, first.longitude)
          : '여행'
      return {
        id: `trip-${index}-${first.capturedAt}`,
        type: 'trip' as const,
        month: monthOf(first),
        title: `${destination} · ${dateKey(first).replaceAll('-', '.')} - ${dateKey(last).replaceAll('-', '.')}`,
        photoIds: group.map((photo) => photo.id),
        note: '',
        coverPhotoId: first.id,
      } satisfies Chapter
    }),
  )

  return ensureMonthChapters(photos, trips)
}

/**
 * 월 챕터 = 여행에 안 들어간 사진만.
 * 같은 달 안에서는 월 챕터 다음에 그달 여행 챕터가 오도록 정렬한다.
 */
export function ensureMonthChapters(photos: Photo[], chapters: Chapter[]) {
  const photoIds = new Set(photos.map((photo) => photo.id))
  const next = chapters
    .filter((chapter) => chapter.id !== 'year-book')
    .map((chapter) => ({
      ...chapter,
      photoIds: chapter.photoIds.filter((id) => {
        const photo = photos.find((item) => item.id === id)
        return photo && !photo.omitted
      }),
    }))

  for (const chapter of next) {
    if (chapter.type === 'trip' && !chapter.month) {
      chapter.month = monthOf(photos.find((photo) => photo.id === chapter.photoIds[0]))
    }
    if (chapter.coverPhotoId && !photoIds.has(chapter.coverPhotoId)) {
      chapter.coverPhotoId = chapter.photoIds[0]
    }
  }

  const claimedByTrip = tripPhotoIds(next)
  const byMonth = new Map<number, Photo[]>()
  for (const photo of [...photos].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))) {
    const date = new Date(photo.capturedAt)
    if (Number.isNaN(date.getTime()) || photo.omitted) continue
    if (claimedByTrip.has(photo.id)) continue
    const month = date.getMonth() + 1
    const group = byMonth.get(month) ?? []
    group.push(photo)
    byMonth.set(month, group)
  }

  for (const [month, monthPhotos] of byMonth) {
    let chapter = next.find((item) => item.type === 'month' && item.month === month)
    if (!chapter) {
      chapter = {
        id: `month-${month}`,
        type: 'month',
        month,
        title: `${month}월`,
        photoIds: [],
        note: '',
      }
      next.push(chapter)
    }
    // 여행에 쓰인 사진은 월 챕터에서 제외하고, 나머지 사진만 동기화
    chapter.photoIds = monthPhotos.map((photo) => photo.id)
    if (!chapter.coverManual || !chapter.coverPhotoId || !chapter.photoIds.includes(chapter.coverPhotoId)) {
      chapter.coverPhotoId = chapter.photoIds[0]
    }
  }

  // 사진이 비게 된 월 챕터 제거 (여행만 있는 달은 여행 챕터만 남김)
  const kept = next.filter((chapter) => chapter.photoIds.length > 0)
  return sortChapters(kept, photos)
}
