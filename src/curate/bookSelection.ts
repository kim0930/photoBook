import { MAX_PAGES } from '../settings/bookSize'
import type { Chapter, FaceGroup, HiddenRange, Photo } from '../types'
import { scoreQuality, signalExclude } from './signals'

export interface BookFilter {
  hiddenRanges: HiddenRange[]
  faceGroups: FaceGroup[]
}

export const EMPTY_BOOK_FILTER: BookFilter = { hiddenRanges: [], faceGroups: [] }

export function selectForBook(photos: Photo[], chapters: Chapter[], filter: BookFilter = EMPTY_BOOK_FILTER) {
  const hiddenFaces = new Set(filter.faceGroups.filter((group) => group.hidden).flatMap((group) => group.photoIds))
  let ranked = photos.map((photo) => markPhoto(photo, filter.hiddenRanges, hiddenFaces))
  const byId = () => new Map(ranked.map((photo) => [photo.id, photo]))

  while (estimatePages(chapters, byId()) > MAX_PAGES) {
    const victim = lowestInLargestEvent(ranked, chapters)
    if (!victim) break
    ranked = ranked.map((photo) => {
      if (photo.id !== victim.id) return photo
      const specific = signalExclude(photo)
      if (specific) return { ...photo, inBook: false, holdReason: undefined, excludeReason: specific }
      if (photo.burstBest === false) return { ...photo, inBook: false, holdReason: undefined, excludeReason: 'duplicate' }
      return { ...photo, inBook: false, holdReason: 'budget' }
    })
  }

  const included = byId()
  const nextChapters = chapters.map((chapter) => {
    if (chapter.coverManual && chapter.coverPhotoId && included.get(chapter.coverPhotoId)?.inBook) return chapter
    const best = chapter.photoIds
      .map((id) => included.get(id))
      .filter((photo): photo is Photo => Boolean(photo?.inBook))
      .sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0) || a.id.localeCompare(b.id))[0]
    if (!best || best.id === chapter.coverPhotoId) return chapter
    return { ...chapter, coverPhotoId: best.id }
  })
  return { photos: ranked, chapters: nextChapters }
}

export function bookPhoto(photo: Photo | undefined): photo is Photo {
  if (!photo || photo.omitted || photo.inBook === false) return false
  if (photo.inBook === true) return true
  return !photo.excludeReason && photo.burstBest !== false
}

function markPhoto(photo: Photo, ranges: HiddenRange[], hiddenFaces: Set<string>): Photo {
  const quality = photo.quality ?? scoreQuality(photo)
  if (photo.omitted) return { ...photo, quality, inBook: false, holdReason: undefined }
  if (inHiddenRange(photo, ranges)) return { ...photo, quality, inBook: false, holdReason: 'date' }
  if (hiddenFaces.has(photo.id)) return { ...photo, quality, inBook: false, holdReason: 'face' }
  if (!photo.forcedIn && (photo.excludeReason || photo.burstBest === false)) {
    return {
      ...photo,
      quality,
      inBook: false,
      holdReason: undefined,
      excludeReason: photo.excludeReason ?? 'duplicate',
    }
  }
  return { ...photo, quality, inBook: true, holdReason: undefined, excludeReason: photo.forcedIn ? undefined : photo.excludeReason }
}

function inHiddenRange(photo: Photo, ranges: HiddenRange[]) {
  const day = photo.capturedAt.slice(0, 10)
  return ranges.some((range) => day >= range.start && day <= range.end)
}

function lowestInLargestEvent(photos: Photo[], chapters: Chapter[]) {
  const inBook = new Set(photos.filter((photo) => photo.inBook).map((photo) => photo.id))
  const events = new Map<string, Photo[]>()
  for (const chapter of chapters) {
    for (const id of chapter.photoIds) {
      const photo = photos.find((item) => item.id === id)
      if (!photo || !inBook.has(photo.id) || photo.forcedIn || photo.layoutLocked) continue
      const key = photo.eventId ?? chapter.id
      const group = events.get(key) ?? []
      if (group.some((item) => item.id === photo.id)) continue
      group.push(photo)
      events.set(key, group)
    }
  }
  const largest = [...events.values()].sort((a, b) => b.length - a.length || worst(a) - worst(b))[0]
  if (!largest || largest.length < 2) {
    return [...events.values()].flat().sort((a, b) => worst([a]) - worst([b]) || a.id.localeCompare(b.id))[0]
  }
  return [...largest].sort((a, b) => (a.quality ?? 0) - (b.quality ?? 0) || a.id.localeCompare(b.id))[0]
}

function worst(photos: Photo[]) {
  return Math.min(...photos.map((photo) => photo.quality ?? 0))
}

function estimatePages(chapters: Chapter[], photos: Map<string, Photo>) {
  let pages = 0
  for (const chapter of chapters) {
    const kept = chapter.photoIds.filter((id) => bookPhoto(photos.get(id)))
    if (!kept.length) continue
    pages += chapter.type === 'trip' ? 2 : 1
    pages += Math.ceil(Math.max(0, kept.length - 1) / 4)
  }
  return pages
}
