import { cachedPlace } from '../chapters/tripDetection'
import type { Chapter, FaceGroup, HiddenRange, Photo } from '../types'

export interface MemoryCard {
  id: string
  kind: 'trip' | 'event' | 'month' | 'place' | 'color' | 'person'
  title: string
  subtitle: string
  photoIds: string[]
  start?: string
  end?: string
}

export function buildMemories(photos: Photo[], chapters: Chapter[], ranges: HiddenRange[], groups: FaceGroup[]) {
  const visible = photos.filter((photo) => !photo.omitted && !hidden(photo, ranges, groups))
  const cards: MemoryCard[] = []

  for (const chapter of chapters) {
    if (chapter.type !== 'trip') continue
    const ids = chapter.photoIds.filter((id) => visible.some((photo) => photo.id === id))
    if (ids.length < 2) continue
    const span = dateSpan(ids, visible)
    cards.push({ id: `memory-${chapter.id}`, kind: 'trip', title: chapter.title.split(' · ')[0] || chapter.title, subtitle: span.label, photoIds: ids, ...span.range })
  }

  const events = new Map<string, Photo[]>()
  for (const photo of visible) {
    if (!photo.eventId) continue
    const group = events.get(photo.eventId) ?? []
    group.push(photo)
    events.set(photo.eventId, group)
  }
  for (const [eventId, group] of events) {
    if (group.length < 2) continue
    const span = dateSpan(group.map((photo) => photo.id), group)
    cards.push({ id: `memory-${eventId}`, kind: 'event', title: span.label, subtitle: `${group.length}장`, photoIds: group.map((photo) => photo.id), ...span.range })
  }

  for (let month = 1; month <= 12; month += 1) {
    const group = visible.filter((photo) => new Date(photo.capturedAt).getMonth() + 1 === month)
    if (group.length < 3) continue
    const best = [...group].sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0)).slice(0, 8)
    cards.push({
      id: `memory-month-${month}`,
      kind: 'month',
      title: `${month}월 하이라이트`,
      subtitle: `${best.length}장`,
      photoIds: best.map((photo) => photo.id),
      start: best[0]?.capturedAt.slice(0, 10),
      end: best.at(-1)?.capturedAt.slice(0, 10),
    })
  }

  const places = new Map<string, Photo[]>()
  for (const photo of visible) {
    if (photo.latitude == null || photo.longitude == null) continue
    const key = `${photo.latitude.toFixed(2)},${photo.longitude.toFixed(2)}`
    const group = places.get(key) ?? []
    group.push(photo)
    places.set(key, group)
  }
  for (const [key, group] of places) {
    if (group.length < 3) continue
    const [lat, lon] = key.split(',').map(Number)
    const span = dateSpan(group.map((photo) => photo.id), group)
    const title = readPlace(lat, lon) || '장소'
    cards.push({
      id: `memory-place-${key}`,
      kind: 'place',
      title,
      subtitle: `${group.length}장`,
      photoIds: group.map((photo) => photo.id),
      ...span.range,
    })
  }

  const colors = new Map<string, Photo[]>()
  for (const photo of visible) {
    const color = photo.analysis?.dominantColor
    if (!color) continue
    const group = colors.get(color) ?? []
    group.push(photo)
    colors.set(color, group)
  }
  for (const [color, group] of colors) {
    if (group.length < 3) continue
    cards.push({
      id: `memory-color-${color}`,
      kind: 'color',
      title: '비슷한 색',
      subtitle: `${group.length}장`,
      photoIds: group.map((photo) => photo.id),
    })
  }

  for (const group of groups) {
    if (group.hidden || group.photoIds.length < 3) continue
    const ids = group.photoIds.filter((id) => visible.some((photo) => photo.id === id))
    if (ids.length < 3) continue
    cards.push({ id: `memory-person-${group.id}`, kind: 'person', title: group.name || '사람', subtitle: `${ids.length}장`, photoIds: ids })
  }

  return cards
}

function readPlace(lat: number, lon: number) {
  try {
    return cachedPlace(lat, lon)
  } catch {
    return ''
  }
}

function hidden(photo: Photo, ranges: HiddenRange[], groups: FaceGroup[]) {
  const day = photo.capturedAt.slice(0, 10)
  if (ranges.some((range) => day >= range.start && day <= range.end)) return true
  return groups.some((group) => group.hidden && group.photoIds.includes(photo.id))
}

function dateSpan(ids: string[], photos: Photo[]) {
  const dated = ids
    .map((id) => photos.find((photo) => photo.id === id)?.capturedAt.slice(0, 10))
    .filter((day): day is string => Boolean(day))
    .sort()
  const start = dated[0]
  const end = dated.at(-1)
  const label = start && end ? (start === end ? start.replaceAll('-', '.') : `${start.replaceAll('-', '.')} – ${end.replaceAll('-', '.')}`) : ''
  return { label, range: { start, end } }
}
