import Dexie, { type EntityTable } from 'dexie'
import type { BookCoverDesign, BookPage, Chapter, CurationSettings, DecorFrame, DrawStroke, FaceGroup, FlowAspect, PageCaption, PageMapWidget, PageNote, PageSticker, Photo } from './types'

type StoredPhoto = Omit<Photo, 'url' | 'thumbUrl' | 'file' | 'movie'> & { thumbnail: Blob; bookId: string }
type StoredPhotoFile = { id: string; file: Blob; movie?: Blob }
type StoredPageNotes = { pageId: string; notes: PageNote[] }
type StoredDrawings = { pageId: string; strokes: DrawStroke[] }
type StoredCover = BookCoverDesign & { id: string }
type StoredCaption = PageCaption & { pageId: string }
type StoredSettings = CurationSettings & { id: string }
type StoredPageStickers = { pageId: string; stickers: PageSticker[] }
type StoredPageMap = PageMapWidget & { pageId: string }
type StoredFaceGroup = FaceGroup & { bookId: string }
type StoredChapter = Chapter & { bookId: string }

export interface BookRecord {
  id: string
  title: string
  year: number
  periodLabel: string
  photoCount: number
  coverPhotoId?: string
  createdAt: string
  updatedAt: string
}

export interface BookListItem extends BookRecord {
  coverThumbUrl?: string
}

export interface BookLayoutSnapshot {
  pages: BookPage[]
  layoutOverrides: Record<string, string>
  flowAspectModes: Record<string, FlowAspect>
  layoutRevision: number
  selectedPageId?: string
  pageFrame?: DecorFrame
}

type StoredBookLayout = BookLayoutSnapshot & { id: string }

const EMPTY_FILE = new Blob()
const ACTIVE_BOOK_KEY = 'photobook-active-book-id'

let activeBookId: string | undefined = localStorage.getItem(ACTIVE_BOOK_KEY) || undefined

export function getActiveBookId() {
  return activeBookId
}

export function setActiveBookId(bookId: string | undefined) {
  activeBookId = bookId
  if (bookId) localStorage.setItem(ACTIVE_BOOK_KEY, bookId)
  else localStorage.removeItem(ACTIVE_BOOK_KEY)
}

function requireBookId(bookId = activeBookId) {
  if (!bookId) throw new Error('활성 포토북이 없습니다.')
  return bookId
}

class PhotoBookDatabase extends Dexie {
  books!: EntityTable<BookRecord, 'id'>
  photos!: EntityTable<StoredPhoto, 'id'>
  photoFiles!: EntityTable<StoredPhotoFile, 'id'>
  chapters!: EntityTable<StoredChapter, 'id'>
  pageNotes!: EntityTable<StoredPageNotes, 'pageId'>
  drawings!: EntityTable<StoredDrawings, 'pageId'>
  bookCover!: EntityTable<StoredCover, 'id'>
  pageCaptions!: EntityTable<StoredCaption, 'pageId'>
  faceGroups!: EntityTable<StoredFaceGroup, 'id'>
  curationSettings!: EntityTable<StoredSettings, 'id'>
  pageStickers!: EntityTable<StoredPageStickers, 'pageId'>
  pageMaps!: EntityTable<StoredPageMap, 'pageId'>
  pageFlags!: EntityTable<{ pageId: string; completed: boolean }, 'pageId'>
  bookLayout!: EntityTable<StoredBookLayout, 'id'>

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
    this.version(6).stores({
      pageStickers: 'pageId',
      pageMaps: 'pageId',
    })
    this.version(7).stores({
      pageFlags: 'pageId',
    })
    // 원본·라이브 영상은 별도 테이블로 분리해 불러오기 때 썸네일만 읽는다.
    this.version(8).stores({
      photoFiles: 'id',
    }).upgrade(async (tx) => {
      const photos = tx.table('photos')
      const files = tx.table('photoFiles')
      const rows = await photos.toArray()
      for (const row of rows) {
        const legacy = row as StoredPhoto & { file?: Blob; movie?: Blob }
        if (legacy.file || legacy.movie) {
          await files.put({ id: legacy.id, file: legacy.file ?? EMPTY_FILE, movie: legacy.movie })
          delete legacy.file
          delete legacy.movie
          await photos.put(legacy)
        }
      }
    })
    this.version(9).stores({
      bookLayout: 'id',
    })
    this.version(10).stores({
      books: 'id, updatedAt',
      photos: 'id, bookId, capturedAt, name',
      chapters: 'id, bookId, type, month',
      faceGroups: 'id, bookId',
      photoFiles: 'id',
      pageNotes: 'pageId',
      drawings: 'pageId',
      bookCover: 'id',
      pageCaptions: 'pageId',
      curationSettings: 'id',
      pageStickers: 'pageId',
      pageMaps: 'pageId',
      pageFlags: 'pageId',
      bookLayout: 'id',
    }).upgrade(async (tx) => {
      const photosTable = tx.table('photos')
      const chaptersTable = tx.table('chapters')
      const booksTable = tx.table('books')
      const photos = await photosTable.toArray() as Array<StoredPhoto & { bookId?: string }>
      const chapters = await chaptersTable.toArray() as Array<StoredChapter & { bookId?: string }>
      if (!photos.length && !chapters.length) return

      const bookId = crypto.randomUUID()
      const stamps = photos
        .map((photo) => Date.parse(photo.capturedAt))
        .filter((value) => Number.isFinite(value))
        .sort((a, b) => a - b)
      const year = stamps.length ? new Date(stamps[0]).getFullYear() : new Date().getFullYear()
      const periodLabel = periodFromStamps(stamps) || `${year}년`
      const coverPhotoId = photos.find((photo) => !photo.excludeReason && !photo.omitted)?.id ?? photos[0]?.id
      const now = new Date().toISOString()
      await booksTable.put({
        id: bookId,
        title: periodLabel,
        year,
        periodLabel,
        photoCount: photos.length,
        coverPhotoId,
        createdAt: now,
        updatedAt: now,
      })

      for (const photo of photos) {
        await photosTable.put({ ...photo, bookId })
      }
      for (const chapter of chapters) {
        await chaptersTable.put({ ...chapter, bookId })
      }

      for (const tableName of ['bookCover', 'bookLayout', 'curationSettings'] as const) {
        const table = tx.table(tableName)
        const main = await table.get('main')
        if (main) {
          await table.delete('main')
          await table.put({ ...main, id: bookId })
        }
      }

      const faces = await tx.table('faceGroups').toArray() as Array<FaceGroup & { bookId?: string }>
      for (const face of faces) {
        await tx.table('faceGroups').put({ ...face, bookId })
      }
    })
  }
}

export const db = new PhotoBookDatabase()

function periodFromStamps(stamps: number[]) {
  if (!stamps.length) return ''
  const start = new Date(stamps[0])
  const end = new Date(stamps[stamps.length - 1])
  const format = (date: Date) => `${date.getFullYear()}년 ${date.getMonth() + 1}월`
  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) return format(start)
  if (start.getFullYear() === end.getFullYear()) {
    return `${start.getFullYear()}년 ${start.getMonth() + 1}월 – ${end.getMonth() + 1}월`
  }
  return `${format(start)} – ${format(end)}`
}

export async function listBooks(): Promise<BookListItem[]> {
  const books = await db.books.orderBy('updatedAt').reverse().toArray()
  const items: BookListItem[] = []
  for (const book of books) {
    let coverThumbUrl: string | undefined
    if (book.coverPhotoId) {
      const row = await db.photos.get(book.coverPhotoId)
      if (row?.thumbnail?.size) {
        try { coverThumbUrl = URL.createObjectURL(row.thumbnail) } catch { /* ignore */ }
      }
    }
    items.push({ ...book, coverThumbUrl })
  }
  return items
}

export async function createBook(input: { year: number; title?: string }): Promise<BookRecord> {
  const now = new Date().toISOString()
  const book: BookRecord = {
    id: crypto.randomUUID(),
    title: input.title || `${input.year}년 포토북`,
    year: input.year,
    periodLabel: `${input.year}년`,
    photoCount: 0,
    createdAt: now,
    updatedAt: now,
  }
  await db.books.put(book)
  setActiveBookId(book.id)
  return book
}

export async function updateBookMeta(
  bookId: string,
  patch: Partial<Pick<BookRecord, 'title' | 'year' | 'periodLabel' | 'photoCount' | 'coverPhotoId'>>,
) {
  const current = await db.books.get(bookId)
  if (!current) return
  await db.books.put({
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  })
}

export async function syncBookMetaFromPhotos(bookId: string, photos: Photo[], title?: string) {
  const active = photos.filter((photo) => !photo.omitted)
  const stamps = active
    .map((photo) => Date.parse(photo.capturedAt))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b)
  const year = stamps.length ? new Date(stamps[0]).getFullYear() : (await db.books.get(bookId))?.year ?? new Date().getFullYear()
  const periodLabel = periodFromStamps(stamps) || `${year}년`
  const coverPhotoId = active.find((photo) => photo.inBook !== false && !photo.excludeReason)?.id
    ?? active[0]?.id
  await updateBookMeta(bookId, {
    title: title || periodLabel,
    year,
    periodLabel,
    photoCount: photos.length,
    coverPhotoId,
  })
}

export async function deleteBook(bookId: string) {
  const layout = await db.bookLayout.get(bookId)
  const pageIds = layout?.pages.map((page) => page.id) ?? []
  const photoIds = (await db.photos.where('bookId').equals(bookId).primaryKeys()) as string[]
  const chapterIds = (await db.chapters.where('bookId').equals(bookId).primaryKeys()) as string[]
  const faceIds = (await db.faceGroups.where('bookId').equals(bookId).primaryKeys()) as string[]

  await db.transaction(
    'rw',
    [
      db.books,
      db.photos,
      db.photoFiles,
      db.chapters,
      db.pageNotes,
      db.drawings,
      db.bookCover,
      db.pageCaptions,
      db.faceGroups,
      db.curationSettings,
      db.pageStickers,
      db.pageMaps,
      db.pageFlags,
      db.bookLayout,
    ],
    async () => {
      if (photoIds.length) {
        await db.photos.bulkDelete(photoIds)
        await db.photoFiles.bulkDelete(photoIds)
      }
      if (chapterIds.length) await db.chapters.bulkDelete(chapterIds)
      if (faceIds.length) await db.faceGroups.bulkDelete(faceIds)
      if (pageIds.length) {
        await db.pageNotes.bulkDelete(pageIds)
        await db.drawings.bulkDelete(pageIds)
        await db.pageCaptions.bulkDelete(pageIds)
        await db.pageStickers.bulkDelete(pageIds)
        await db.pageMaps.bulkDelete(pageIds)
        await db.pageFlags.bulkDelete(pageIds)
      }
      await db.bookCover.delete(bookId)
      await db.curationSettings.delete(bookId)
      await db.bookLayout.delete(bookId)
      await db.books.delete(bookId)
    },
  )

  if (activeBookId === bookId) setActiveBookId(undefined)
}

export async function persistPhoto(photo: Photo, thumbnail: Blob, displayBlob: Blob = photo.file) {
  const bookId = requireBookId()
  const { url: _url, thumbUrl: _thumbUrl, file: _file, movie, ...meta } = photo
  await db.transaction('rw', db.photos, db.photoFiles, async () => {
    await db.photos.put({ ...meta, thumbnail, bookId })
    await db.photoFiles.put({ id: photo.id, file: displayBlob, movie })
  })
}

export async function deletePhotoBinary(id: string) {
  await db.photoFiles.delete(id)
}

export async function attachPhotoBinary(photo: Photo): Promise<Photo> {
  const row = await db.photoFiles.get(photo.id)
  if (!row) return photo
  return { ...photo, file: row.file?.size ? row.file : photo.file, movie: row.movie ?? photo.movie }
}

export async function attachPhotoBinaries(photos: Photo[]): Promise<Photo[]> {
  if (!photos.length) return photos
  const rows = await db.photoFiles.bulkGet(photos.map((photo) => photo.id))
  return photos.map((photo, index) => {
    const row = rows[index]
    if (!row) return photo
    return {
      ...photo,
      file: row.file?.size ? row.file : photo.file,
      movie: row.movie ?? photo.movie,
    }
  })
}

export async function syncChapters(chapters: Chapter[], bookId = activeBookId) {
  const id = requireBookId(bookId)
  await db.transaction('rw', db.chapters, async () => {
    const existing = await db.chapters.where('bookId').equals(id).toArray()
    const keep = new Set(chapters.map((chapter) => chapter.id))
    await db.chapters.bulkDelete(existing.filter((chapter) => !keep.has(chapter.id)).map((chapter) => chapter.id))
    if (chapters.length) {
      await db.chapters.bulkPut(chapters.map((chapter) => ({ ...chapter, bookId: id })))
    }
  })
}

export async function loadPageNotes(pageIds?: string[]) {
  if (pageIds) {
    const rows = await db.pageNotes.bulkGet(pageIds)
    return Object.fromEntries(
      rows.flatMap((row) => (row ? [[row.pageId, row.notes] as const] : [])),
    )
  }
  const rows = await db.pageNotes.toArray()
  return Object.fromEntries(rows.map((row) => [row.pageId, row.notes]))
}

export async function savePageNotes(pageId: string, notes: PageNote[]) {
  if (!notes.length) await db.pageNotes.delete(pageId)
  else await db.pageNotes.put({ pageId, notes })
}

export async function loadDrawings(pageIds?: string[]) {
  if (pageIds) {
    const rows = await db.drawings.bulkGet(pageIds)
    return Object.fromEntries(
      rows.flatMap((row) => (row ? [[row.pageId, row.strokes] as const] : [])),
    )
  }
  const rows = await db.drawings.toArray()
  return Object.fromEntries(rows.map((row) => [row.pageId, row.strokes]))
}

export async function saveDrawings(pageId: string, strokes: DrawStroke[]) {
  if (!strokes.length) await db.drawings.delete(pageId)
  else await db.drawings.put({ pageId, strokes })
}

export async function loadCover(bookId = activeBookId): Promise<BookCoverDesign | undefined> {
  if (!bookId) return undefined
  const row = await db.bookCover.get(bookId)
  if (!row) return undefined
  const { id: _id, ...cover } = row
  return cover
}

export async function saveCover(cover: BookCoverDesign, bookId = activeBookId) {
  const id = requireBookId(bookId)
  await db.bookCover.put({ ...cover, id })
}

export async function loadPageCaptions(pageIds?: string[]) {
  if (pageIds) {
    const rows = await db.pageCaptions.bulkGet(pageIds)
    return Object.fromEntries(
      rows.flatMap((row) => {
        if (!row) return []
        const { pageId, ...caption } = row
        return [[pageId, caption] as const]
      }),
    )
  }
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

export async function loadFaceGroups(bookId = activeBookId) {
  if (!bookId) return [] as FaceGroup[]
  const rows = await db.faceGroups.where('bookId').equals(bookId).toArray()
  return rows.map(({ bookId: _bookId, ...group }) => group)
}

export async function saveFaceGroups(groups: FaceGroup[], bookId = activeBookId) {
  const id = requireBookId(bookId)
  await db.transaction('rw', db.faceGroups, async () => {
    const existing = await db.faceGroups.where('bookId').equals(id).primaryKeys()
    if (existing.length) await db.faceGroups.bulkDelete(existing as string[])
    if (groups.length) {
      await db.faceGroups.bulkPut(groups.map((group) => ({ ...group, bookId: id })))
    }
  })
}

export async function loadCurationSettings(bookId = activeBookId): Promise<CurationSettings> {
  if (!bookId) return { faceGroupsEnabled: false, hiddenRanges: [], focusFaceIds: [] }
  const row = await db.curationSettings.get(bookId)
  if (!row) return { faceGroupsEnabled: false, hiddenRanges: [], focusFaceIds: [] }
  const { id: _id, ...settings } = row
  return { focusFaceIds: [], ...settings }
}

export async function saveCurationSettings(settings: CurationSettings, bookId = activeBookId) {
  const id = requireBookId(bookId)
  await db.curationSettings.put({ ...settings, id })
}

export async function loadPageStickers(pageIds?: string[]) {
  if (pageIds) {
    const rows = await db.pageStickers.bulkGet(pageIds)
    return Object.fromEntries(
      rows.flatMap((row) => (row ? [[row.pageId, row.stickers] as const] : [])),
    )
  }
  const rows = await db.pageStickers.toArray()
  return Object.fromEntries(rows.map((row) => [row.pageId, row.stickers]))
}

export async function savePageStickers(pageId: string, stickers: PageSticker[]) {
  if (!stickers.length) await db.pageStickers.delete(pageId)
  else await db.pageStickers.put({ pageId, stickers })
}

export async function loadPageMaps(pageIds?: string[]) {
  if (pageIds) {
    const rows = await db.pageMaps.bulkGet(pageIds)
    return Object.fromEntries(
      rows.flatMap((row) => {
        if (!row) return []
        const { pageId, ...widget } = row
        return [[pageId, widget] as const]
      }),
    )
  }
  const rows = await db.pageMaps.toArray()
  return Object.fromEntries(rows.map(({ pageId, ...widget }) => [pageId, widget]))
}

export async function savePageMap(pageId: string, widget: PageMapWidget | undefined) {
  if (!widget) await db.pageMaps.delete(pageId)
  else await db.pageMaps.put({ pageId, ...widget })
}

export async function loadCompletedPages(pageIds?: string[]): Promise<Record<string, boolean>> {
  try {
    if (pageIds) {
      const rows = await db.pageFlags.bulkGet(pageIds)
      return Object.fromEntries(
        rows.flatMap((row) => (row?.completed ? [[row.pageId, true as const]] : [])),
      )
    }
    const rows = await db.pageFlags.toArray()
    return Object.fromEntries(rows.filter((row) => row.completed).map((row) => [row.pageId, true as const]))
  } catch (error) {
    console.warn('완료 페이지 정보를 불러오지 못했습니다.', error)
    return {}
  }
}

export async function savePageCompleted(pageId: string, completed: boolean) {
  if (!completed) await db.pageFlags.delete(pageId)
  else await db.pageFlags.put({ pageId, completed: true })
}

export async function clearCompletedPages(pageIds?: string[]) {
  if (pageIds?.length) {
    await db.pageFlags.bulkDelete(pageIds)
    return
  }
  await db.pageFlags.clear()
}

export async function loadBookLayout(bookId = activeBookId): Promise<BookLayoutSnapshot | undefined> {
  try {
    if (!bookId) return undefined
    const row = await db.bookLayout.get(bookId)
    if (!row?.pages?.length) return undefined
    const { id: _id, ...layout } = row
    return layout
  } catch (error) {
    console.warn('페이지 배치를 불러오지 못했습니다.', error)
    return undefined
  }
}

export async function saveBookLayout(layout: BookLayoutSnapshot, bookId = activeBookId) {
  const id = requireBookId(bookId)
  await db.bookLayout.put({ ...layout, id })
}

export async function clearBookLayout(bookId = activeBookId) {
  if (!bookId) return
  await db.bookLayout.delete(bookId)
}

/** 활성 포토북의 사진·챕터·부가 데이터만 비운다. 다른 책은 유지. */
export async function clearActiveLibrary(bookId = activeBookId) {
  if (!bookId) return
  await deleteBook(bookId)
}

export async function clearLibrary() {
  await db.transaction(
    'rw',
    [
      db.books,
      db.photos,
      db.photoFiles,
      db.chapters,
      db.pageNotes,
      db.drawings,
      db.bookCover,
      db.pageCaptions,
      db.faceGroups,
      db.curationSettings,
      db.pageStickers,
      db.pageMaps,
      db.pageFlags,
      db.bookLayout,
    ],
    async () => {
      await Promise.all([
        db.books.clear(),
        db.photos.clear(),
        db.photoFiles.clear(),
        db.chapters.clear(),
        db.pageNotes.clear(),
        db.drawings.clear(),
        db.bookCover.clear(),
        db.pageCaptions.clear(),
        db.faceGroups.clear(),
        db.curationSettings.clear(),
        db.pageStickers.clear(),
        db.pageMaps.clear(),
        db.pageFlags.clear(),
        db.bookLayout.clear(),
      ])
    },
  )
  setActiveBookId(undefined)
}

const PLACEHOLDER_THUMB =
  'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320"><rect width="100%" height="100%" fill="#e3ddd4"/><text x="50%" y="52%" text-anchor="middle" fill="#9a9288" font-size="18" font-family="sans-serif">사진</text></svg>',
  )

export async function loadLibrary(bookId = activeBookId): Promise<{ photos: Photo[]; chapters: Chapter[] }> {
  if (!bookId) return { photos: [], chapters: [] }
  const [storedPhotos, chapters] = await Promise.all([
    db.photos.where('bookId').equals(bookId).toArray(),
    db.chapters.where('bookId').equals(bookId).toArray(),
  ])
  const photos = storedPhotos.map((row) => photoFromStored(row))
  return {
    photos,
    chapters: chapters.map(({ bookId: _bookId, ...chapter }) => chapter),
  }
}

export async function loadBookWorkspace(bookId: string) {
  setActiveBookId(bookId)
  const [library, bookLayout] = await Promise.all([
    loadLibrary(bookId),
    loadBookLayout(bookId),
  ])
  const pageIds = bookLayout?.pages.map((page) => page.id)
    ?? []
  const [pageNotes, drawings, cover, pageCaptions, curation, faceGroups, pageStickers, pageMaps, completedPages] = await Promise.all([
    loadPageNotes(pageIds.length ? pageIds : undefined),
    loadDrawings(pageIds.length ? pageIds : undefined),
    loadCover(bookId),
    loadPageCaptions(pageIds.length ? pageIds : undefined),
    loadCurationSettings(bookId),
    loadFaceGroups(bookId),
    loadPageStickers(pageIds.length ? pageIds : undefined),
    loadPageMaps(pageIds.length ? pageIds : undefined),
    loadCompletedPages(pageIds.length ? pageIds : undefined),
  ])
  return {
    library,
    bookLayout,
    pageNotes,
    drawings,
    cover,
    pageCaptions,
    curation,
    faceGroups,
    pageStickers,
    pageMaps,
    completedPages,
  }
}

/** IndexedDB에서 꺼낸 썸네일로 표시용 URL을 다시 만든다. */
export async function refreshPhotoDisplayUrls(photos: Photo[]): Promise<Photo[]> {
  const rows = await db.photos.bulkGet(photos.map((photo) => photo.id))
  return photos.map((photo, index) => {
    const row = rows[index]
    if (photo.url?.startsWith('blob:')) {
      try { URL.revokeObjectURL(photo.url) } catch { /* ignore */ }
    }
    if (!row) {
      return { ...photo, url: PLACEHOLDER_THUMB, thumbUrl: PLACEHOLDER_THUMB }
    }
    const next = photoFromStored(row)
    return {
      ...photo,
      selectedFrame: next.selectedFrame,
      url: next.url,
      thumbUrl: next.thumbUrl,
    }
  })
}

export function revokePhotoUrls(photos: Photo[]) {
  for (const photo of photos) {
    if (photo.url?.startsWith('blob:')) {
      try { URL.revokeObjectURL(photo.url) } catch { /* ignore */ }
    }
    if (photo.thumbUrl?.startsWith('blob:') && photo.thumbUrl !== photo.url) {
      try { URL.revokeObjectURL(photo.thumbUrl) } catch { /* ignore */ }
    }
  }
}

function photoFromStored(row: StoredPhoto): Photo {
  const { thumbnail, bookId: _bookId, ...photo } = row
  const base = { ...photo, file: EMPTY_FILE, movie: undefined as Blob | undefined }
  if (photo.selectedFrame?.startsWith('data:')) {
    return { ...base, url: photo.selectedFrame, thumbUrl: photo.selectedFrame }
  }
  if (thumbnail && thumbnail.size > 0) {
    try {
      const url = URL.createObjectURL(thumbnail)
      return { ...base, url, thumbUrl: url }
    } catch {
      /* fall through */
    }
  }
  return { ...base, url: PLACEHOLDER_THUMB, thumbUrl: PLACEHOLDER_THUMB }
}
