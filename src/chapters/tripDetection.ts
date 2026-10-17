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

export async function buildChapters(photos: Photo[], thresholdKm = 50): Promise<Chapter[]> {
  const home = estimateHome(photos)
  const away = home
    ? photos.filter(
        (p) =>
          p.latitude != null &&
          p.longitude != null &&
          distanceKm(home, [p.latitude, p.longitude]) >= thresholdKm,
      )
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

  const tripIds = new Set(tripGroups.flat().map((photo) => photo.id))
  const monthChapters: Chapter[] = Array.from({ length: 12 }, (_, index) => {
    const monthPhotos = photos.filter(
      (photo) => new Date(photo.capturedAt).getMonth() === index && !tripIds.has(photo.id),
    )
    return {
      id: `month-${index + 1}`,
      type: 'month',
      month: index + 1,
      title: `${index + 1}월`,
      photoIds: monthPhotos.map((photo) => photo.id),
      note: '',
      coverPhotoId: monthPhotos[0]?.id,
    } satisfies Chapter
  }).filter((chapter) => chapter.photoIds.length > 0)

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
        type: 'trip',
        title: `${destination} · ${dateKey(first).replaceAll('-', '.')} - ${dateKey(last).replaceAll('-', '.')}`,
        photoIds: group.map((photo) => photo.id),
        note: '',
        coverPhotoId: first.id,
      } satisfies Chapter
    }),
  )

  return ensureMonthChapters(photos, [...monthChapters, ...trips])
}

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
    if (chapter.coverPhotoId && !photoIds.has(chapter.coverPhotoId)) chapter.coverPhotoId = chapter.photoIds[0]
  }
  const byMonth = new Map<number, Photo[]>()
  for (const photo of [...photos].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))) {
    const date = new Date(photo.capturedAt)
    if (Number.isNaN(date.getTime()) || photo.omitted) continue
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
    const included = new Set(chapter.photoIds)
    for (const photo of monthPhotos) {
      if (!included.has(photo.id)) chapter.photoIds.push(photo.id)
    }
    if (!chapter.coverPhotoId) chapter.coverPhotoId = chapter.photoIds[0]
  }
  return next
    .filter((chapter) => chapter.photoIds.length > 0)
    .sort((a, b) => {
      const aDate = photos.find((photo) => photo.id === a.photoIds[0])?.capturedAt ?? ''
      const bDate = photos.find((photo) => photo.id === b.photoIds[0])?.capturedAt ?? ''
      return aDate.localeCompare(bDate)
    })
}
