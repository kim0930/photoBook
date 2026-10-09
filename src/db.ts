import Dexie, { type EntityTable } from 'dexie'
import type { BookCoverDesign, Chapter, CurationSettings, DrawStroke, FaceGroup, PageCaption, PageNote, Photo } from './types'

type StoredPhoto = Omit<Photo, 'url' | 'thumbUrl'> & { thumbnail: Blob }
type StoredPageNotes = { pageId: string; notes: PageNote[] }
type StoredDrawings = { pageId: string; strokes: DrawStroke[] }
type StoredCover = BookCoverDesign & { id: string }
type StoredCaption = PageCaption & { pageId: string }
type StoredSettings = CurationSettings & { id: string }

class PhotoBookDatabase extends Dexie {
  photos!: EntityTable<StoredPhoto, 'id'>
  chapters!: EntityTable<Chapter, 'id'>
  pageNotes!: EntityTable<StoredPageNotes, 'pageId'>
  drawings!: EntityTable<StoredDrawings, 'pageId'>
  bookCover!: EntityTable<StoredCover, 'id'>
  pageCaptions!: EntityTable<StoredCaption, 'pageId'>
  faceGroups!: EntityTable<FaceGroup, 'id'>
  curationSettings!: EntityTable<StoredSettings, 'id'>

  constructor() {
    super('yearly-photobook')
    this.version(1).stores({
      photos: 'id, capturedAt, name',
      chapters: 'id, type, month',
    })
    this.version(2).stores({
      pageNotes: 'pageId',
    })
    this.version(3).stores({
      drawings: 'pageId',
      bookCover: 'id',
    })
    this.version(4).stores({
      pageCaptions: 'pageId',
    })
    this.version(5).stores({
      faceGroups: 'id',
      curationSettings: 'id',
    })
  }
}

export const db = new PhotoBookDatabase()

export async function persistPhoto(photo: Photo, thumbnail: Blob, displayBlob: Blob = photo.file) {
  const { url: _url, thumbUrl: _thumbUrl, ...stored } = photo
  await db.photos.put({ ...stored, file: displayBlob, thumbnail })
}

export async function syncChapters(chapters: Chapter[]) {
  await db.transaction('rw', db.chapters, async () => {
    const existing = await db.chapters.toArray()
    const ids = new Set(chapters.map((chapter) => chapter.id))
    await db.chapters.bulkDelete(existing.filter((chapter) => !ids.has(chapter.id)).map((chapter) => chapter.id))
    if (chapters.length) await db.chapters.bulkPut(chapters)
  })
}

export async function loadPageNotes() {
  const rows = await db.pageNotes.toArray()
  return Object.fromEntries(rows.map((row) => [row.pageId, row.notes]))
}

export async function savePageNotes(pageId: string, notes: PageNote[]) {
  if (!notes.length) await db.pageNotes.delete(pageId)
  else await db.pageNotes.put({ pageId, notes })
}

export async function loadDrawings() {
  const rows = await db.drawings.toArray()
  return Object.fromEntries(rows.map((row) => [row.pageId, row.strokes]))
}

export async function saveDrawings(pageId: string, strokes: DrawStroke[]) {
  if (!strokes.length) await db.drawings.delete(pageId)
  else await db.drawings.put({ pageId, strokes })
}

export async function loadCover(): Promise<BookCoverDesign | undefined> {
  const row = await db.bookCover.get('main')
  if (!row) return undefined
  const { id: _id, ...cover } = row
  return cover
}

export async function saveCover(cover: BookCoverDesign) {
  await db.bookCover.put({ ...cover, id: 'main' })
}

export async function loadPageCaptions() {
  const rows = await db.pageCaptions.toArray()
  return Object.fromEntries(rows.map(({ pageId, ...caption }) => [pageId, caption]))
}

export async function savePageCaption(pageId: string, caption: PageCaption) {
  if (caption.date === undefined && caption.place === undefined && caption.page === undefined) {
    await db.pageCaptions.delete(pageId)
  } else {
    await db.pageCaptions.put({ pageId, ...caption })
  }
}

export async function persistCuration(photos: Photo[]) {
  await db.transaction('rw', db.photos, async () => {
    for (const photo of photos) {
      await db.photos.where('id').equals(photo.id).modify((row) => {
        row.quality = photo.quality
        row.burstId = photo.burstId
        row.burstBest = photo.burstBest
        row.eventId = photo.eventId
        row.thumbHash = photo.thumbHash
        row.faceQuality = photo.faceQuality
        row.forcedIn = photo.forcedIn
        row.ocrText = photo.ocrText
        if (photo.excludeReason) row.excludeReason = photo.excludeReason
        else delete row.excludeReason
      })
    }
  })
}

export async function loadFaceGroups() {
  return db.faceGroups.toArray()
}

export async function saveFaceGroups(groups: FaceGroup[]) {
  await db.transaction('rw', db.faceGroups, async () => {
    await db.faceGroups.clear()
    if (groups.length) await db.faceGroups.bulkPut(groups)
  })
}

export async function loadCurationSettings(): Promise<CurationSettings> {
  const row = await db.curationSettings.get('main')
  if (!row) return { faceGroupsEnabled: false, hiddenRanges: [] }
  const { id: _id, ...settings } = row
  return settings
}

export async function saveCurationSettings(settings: CurationSettings) {
  await db.curationSettings.put({ ...settings, id: 'main' })
}

export async function clearLibrary() {
  await db.transaction('rw', db.photos, db.chapters, db.pageNotes, db.drawings, db.bookCover, db.pageCaptions, db.faceGroups, db.curationSettings, async () => {
    await db.photos.clear()
    await db.chapters.clear()
    await db.pageNotes.clear()
    await db.drawings.clear()
    await db.bookCover.clear()
    await db.pageCaptions.clear()
    await db.faceGroups.clear()
    await db.curationSettings.clear()
  })
}

export async function loadLibrary(): Promise<{ photos: Photo[]; chapters: Chapter[] }> {
  const [storedPhotos, chapters] = await Promise.all([db.photos.toArray(), db.chapters.toArray()])
  const photos = storedPhotos.map(({ thumbnail, ...photo }) => {
    const display = photo.selectedFrame ? dataUrlToBlob(photo.selectedFrame) : thumbnail
    const url = URL.createObjectURL(display)
    return { ...photo, url, thumbUrl: url }
  })
  return { photos, chapters }
}

function dataUrlToBlob(dataUrl: string) {
  const [header, encoded] = dataUrl.split(',')
  const mime = header.match(/data:(.*?);/)?.[1] ?? 'image/jpeg'
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
  return new Blob([bytes], { type: mime })
}
