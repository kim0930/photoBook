import JSZip from 'jszip'
import {
  createBook,
  db,
  syncBookMetaFromPhotos,
  type BookLayoutSnapshot,
  type BookRecord,
} from '../db'
import type { BookCoverDesign, Chapter, CurationSettings, FaceGroup, Photo } from '../types'

const BACKUP_VERSION = 1

type StoredPhotoMeta = Omit<Photo, 'url' | 'thumbUrl' | 'file' | 'movie'> & {
  bookId: string
}

export type BookBackupManifest = {
  version: number
  exportedAt: string
  book: BookRecord
  chapters: Array<Chapter & { bookId: string }>
  photos: StoredPhotoMeta[]
  layout?: BookLayoutSnapshot
  cover?: BookCoverDesign & { id: string }
  curation?: CurationSettings & { id: string }
  faceGroups: Array<FaceGroup & { bookId: string }>
  pageNotes: Array<{ pageId: string; notes: unknown }>
  drawings: Array<{ pageId: string; strokes: unknown }>
  pageCaptions: Array<{ pageId: string } & Record<string, unknown>>
  pageStickers: Array<{ pageId: string; stickers: unknown }>
  pageMaps: Array<{ pageId: string } & Record<string, unknown>>
  pageFlags: Array<{ pageId: string; completed: boolean }>
  hasFiles: string[]
  hasMovies: string[]
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 2_000)
}

function remapList(ids: string[] | undefined, map: Map<string, string>) {
  return (ids ?? []).map((id) => map.get(id) ?? id)
}

export async function exportBookBackup(bookId: string, onProgress?: (label: string) => void) {
  const book = await db.books.get(bookId)
  if (!book) throw new Error('포토북을 찾지 못했습니다.')

  onProgress?.('백업 데이터 수집 중')
  const [photos, chapters, layout, cover, curation, faceGroups] = await Promise.all([
    db.photos.where('bookId').equals(bookId).toArray(),
    db.chapters.where('bookId').equals(bookId).toArray(),
    db.bookLayout.get(bookId),
    db.bookCover.get(bookId),
    db.curationSettings.get(bookId),
    db.faceGroups.where('bookId').equals(bookId).toArray(),
  ])
  const pageIds = layout?.pages.map((page) => page.id) ?? []
  const [pageNotes, drawings, pageCaptions, pageStickers, pageMaps, pageFlags, fileRows] = await Promise.all([
    pageIds.length ? db.pageNotes.bulkGet(pageIds) : Promise.resolve([]),
    pageIds.length ? db.drawings.bulkGet(pageIds) : Promise.resolve([]),
    pageIds.length ? db.pageCaptions.bulkGet(pageIds) : Promise.resolve([]),
    pageIds.length ? db.pageStickers.bulkGet(pageIds) : Promise.resolve([]),
    pageIds.length ? db.pageMaps.bulkGet(pageIds) : Promise.resolve([]),
    pageIds.length ? db.pageFlags.bulkGet(pageIds) : Promise.resolve([]),
    photos.length ? db.photoFiles.bulkGet(photos.map((photo) => photo.id)) : Promise.resolve([]),
  ])

  const zip = new JSZip()
  const hasFiles: string[] = []
  const hasMovies: string[] = []

  for (let index = 0; index < photos.length; index += 1) {
    const photo = photos[index]
    onProgress?.(`사진 백업 ${index + 1}/${photos.length}`)
    if (photo.thumbnail?.size) zip.file(`thumbs/${photo.id}.bin`, photo.thumbnail)
    const fileRow = fileRows[index]
    if (fileRow?.file?.size) {
      zip.file(`files/${photo.id}.bin`, fileRow.file)
      hasFiles.push(photo.id)
    }
    if (fileRow?.movie?.size) {
      zip.file(`movies/${photo.id}.bin`, fileRow.movie)
      hasMovies.push(photo.id)
    }
  }

  const manifest: BookBackupManifest = {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    book,
    chapters,
    photos: photos.map(({ thumbnail: _thumb, ...meta }) => meta),
    layout: layout ? (({ id: _id, ...rest }) => rest)(layout) : undefined,
    cover,
    curation,
    faceGroups,
    pageNotes: pageNotes.filter(Boolean) as unknown as BookBackupManifest['pageNotes'],
    drawings: drawings.filter(Boolean) as unknown as BookBackupManifest['drawings'],
    pageCaptions: pageCaptions.filter(Boolean) as unknown as BookBackupManifest['pageCaptions'],
    pageStickers: pageStickers.filter(Boolean) as unknown as BookBackupManifest['pageStickers'],
    pageMaps: pageMaps.filter(Boolean) as unknown as BookBackupManifest['pageMaps'],
    pageFlags: pageFlags.filter(Boolean) as unknown as BookBackupManifest['pageFlags'],
    hasFiles,
    hasMovies,
  }
  zip.file('manifest.json', JSON.stringify(manifest))

  onProgress?.('압축 파일 만드는 중')
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
  const safeTitle = (book.title || book.periodLabel || 'photobook').replace(/[\\/:*?"<>|]+/g, '_')
  downloadBlob(blob, `${safeTitle}-${book.id.slice(0, 8)}.photobook.zip`)
}

export async function importBookBackup(file: File, onProgress?: (label: string) => void) {
  onProgress?.('백업 파일 읽는 중')
  const zip = await JSZip.loadAsync(file)
  const manifestText = await zip.file('manifest.json')?.async('string')
  if (!manifestText) throw new Error('올바른 포토북 백업 파일이 아닙니다.')
  const manifest = JSON.parse(manifestText) as BookBackupManifest
  if (!manifest?.book || !Array.isArray(manifest.photos)) throw new Error('백업 형식을 읽을 수 없습니다.')

  const created = await createBook({
    year: manifest.book.year || new Date().getFullYear(),
    title: `${manifest.book.title || manifest.book.periodLabel || '복원된 포토북'} (복원)`,
  })
  const bookId = created.id
  const prefix = bookId.slice(0, 8)
  const photoIdMap = new Map(manifest.photos.map((photo) => [photo.id, crypto.randomUUID()]))
  const chapterIdMap = new Map(
    (manifest.chapters ?? []).map((chapter) => [
      chapter.id,
      chapter.id === 'year-book' ? 'year-book' : `${prefix}-${chapter.id}`,
    ]),
  )
  const pageIdMap = new Map(
    (manifest.layout?.pages ?? []).map((page) => [page.id, crypto.randomUUID()]),
  )

  onProgress?.('사진 복원 중')
  for (let index = 0; index < manifest.photos.length; index += 1) {
    const meta = manifest.photos[index]
    const newId = photoIdMap.get(meta.id)!
    const thumbBlob = await zip.file(`thumbs/${meta.id}.bin`)?.async('blob')
    const fileBlob = manifest.hasFiles.includes(meta.id)
      ? await zip.file(`files/${meta.id}.bin`)?.async('blob')
      : undefined
    const movieBlob = manifest.hasMovies.includes(meta.id)
      ? await zip.file(`movies/${meta.id}.bin`)?.async('blob')
      : undefined
    await db.photos.put({
      ...meta,
      id: newId,
      bookId,
      thumbnail: thumbBlob ?? new Blob(),
    } as Parameters<typeof db.photos.put>[0])
    if (fileBlob?.size || movieBlob?.size) {
      await db.photoFiles.put({
        id: newId,
        file: fileBlob ?? new Blob(),
        movie: movieBlob,
      })
    }
    onProgress?.(`사진 복원 ${index + 1}/${manifest.photos.length}`)
  }

  const chapters = (manifest.chapters ?? []).map((chapter) => ({
    ...chapter,
    id: chapterIdMap.get(chapter.id) ?? `${prefix}-${chapter.id}`,
    bookId,
    photoIds: remapList(chapter.photoIds, photoIdMap),
    coverPhotoId: chapter.coverPhotoId ? photoIdMap.get(chapter.coverPhotoId) : undefined,
  }))
  if (chapters.length) await db.chapters.bulkPut(chapters)

  const layoutPages = (manifest.layout?.pages ?? []).map((page) => ({
    ...page,
    id: pageIdMap.get(page.id)!,
    chapterId: chapterIdMap.get(page.chapterId) ?? page.chapterId,
    photoIds: remapList(page.photoIds, photoIdMap),
  }))
  if (layoutPages.length) {
    await db.bookLayout.put({
      id: bookId,
      pages: layoutPages,
      layoutOverrides: Object.fromEntries(
        Object.entries(manifest.layout?.layoutOverrides ?? {}).flatMap(([pageId, layoutId]) => {
          const next = pageIdMap.get(pageId)
          return next ? [[next, layoutId] as const] : []
        }),
      ),
      flowAspectModes: Object.fromEntries(
        Object.entries(manifest.layout?.flowAspectModes ?? {}).flatMap(([pageId, mode]) => {
          const next = pageIdMap.get(pageId)
          return next ? [[next, mode] as const] : []
        }),
      ),
      layoutRevision: manifest.layout?.layoutRevision ?? 0,
      selectedPageId: manifest.layout?.selectedPageId
        ? pageIdMap.get(manifest.layout.selectedPageId)
        : layoutPages[0]?.id,
    })
  }

  if (manifest.cover) {
    const { id: _id, ...cover } = manifest.cover
    await db.bookCover.put({
      ...cover,
      id: bookId,
      frontPhotoId: cover.frontPhotoId ? photoIdMap.get(cover.frontPhotoId) : undefined,
      backPhotoId: cover.backPhotoId ? photoIdMap.get(cover.backPhotoId) : undefined,
    })
  }
  if (manifest.curation) {
    const { id: _id, ...curation } = manifest.curation
    await db.curationSettings.put({ ...curation, id: bookId })
  }
  if (manifest.faceGroups?.length) {
    await db.faceGroups.bulkPut(manifest.faceGroups.map((group) => ({
      ...group,
      id: crypto.randomUUID(),
      bookId,
      photoIds: remapList(group.photoIds, photoIdMap),
      coverPhotoId: group.coverPhotoId ? photoIdMap.get(group.coverPhotoId) : undefined,
    })))
  }

  const remapPage = <T extends { pageId: string }>(rows: T[] = []) =>
    rows
      .filter((row) => pageIdMap.has(row.pageId))
      .map((row) => ({ ...row, pageId: pageIdMap.get(row.pageId)! }))

  const keepNotes = remapPage(manifest.pageNotes)
  if (keepNotes.length) await db.pageNotes.bulkPut(keepNotes as never)
  const keepDrawings = remapPage(manifest.drawings)
  if (keepDrawings.length) await db.drawings.bulkPut(keepDrawings as never)
  const keepCaptions = remapPage(manifest.pageCaptions)
  if (keepCaptions.length) await db.pageCaptions.bulkPut(keepCaptions as never)
  const keepStickers = remapPage(manifest.pageStickers)
  if (keepStickers.length) await db.pageStickers.bulkPut(keepStickers as never)
  const keepMaps = remapPage(manifest.pageMaps)
  if (keepMaps.length) await db.pageMaps.bulkPut(keepMaps as never)
  const keepFlags = remapPage(manifest.pageFlags)
  if (keepFlags.length) await db.pageFlags.bulkPut(keepFlags as never)

  const restoredPhotos = await db.photos.where('bookId').equals(bookId).toArray()
  await syncBookMetaFromPhotos(bookId, restoredPhotos as unknown as Photo[], created.title)
  await db.books.update(bookId, {
    title: created.title,
    periodLabel: manifest.book.periodLabel,
    year: manifest.book.year,
  })
  return bookId
}

export async function duplicateBook(sourceId: string, onProgress?: (label: string) => void) {
  onProgress?.('복제용 데이터 준비 중')
  const book = await db.books.get(sourceId)
  if (!book) throw new Error('포토북을 찾지 못했습니다.')
  const photos = await db.photos.where('bookId').equals(sourceId).toArray()
  const zip = new JSZip()
  const [chapters, layout, cover, curation, faceGroups] = await Promise.all([
    db.chapters.where('bookId').equals(sourceId).toArray(),
    db.bookLayout.get(sourceId),
    db.bookCover.get(sourceId),
    db.curationSettings.get(sourceId),
    db.faceGroups.where('bookId').equals(sourceId).toArray(),
  ])
  const pageIds = layout?.pages.map((page) => page.id) ?? []
  const [pageNotes, drawings, pageCaptions, pageStickers, pageMaps, pageFlags, fileRows] = await Promise.all([
    pageIds.length ? db.pageNotes.bulkGet(pageIds) : Promise.resolve([]),
    pageIds.length ? db.drawings.bulkGet(pageIds) : Promise.resolve([]),
    pageIds.length ? db.pageCaptions.bulkGet(pageIds) : Promise.resolve([]),
    pageIds.length ? db.pageStickers.bulkGet(pageIds) : Promise.resolve([]),
    pageIds.length ? db.pageMaps.bulkGet(pageIds) : Promise.resolve([]),
    pageIds.length ? db.pageFlags.bulkGet(pageIds) : Promise.resolve([]),
    photos.length ? db.photoFiles.bulkGet(photos.map((photo) => photo.id)) : Promise.resolve([]),
  ])
  const hasFiles: string[] = []
  const hasMovies: string[] = []
  for (let index = 0; index < photos.length; index += 1) {
    onProgress?.(`복제 중 ${index + 1}/${photos.length}`)
    const photo = photos[index]
    if (photo.thumbnail?.size) zip.file(`thumbs/${photo.id}.bin`, photo.thumbnail)
    const fileRow = fileRows[index]
    if (fileRow?.file?.size) {
      zip.file(`files/${photo.id}.bin`, fileRow.file)
      hasFiles.push(photo.id)
    }
    if (fileRow?.movie?.size) {
      zip.file(`movies/${photo.id}.bin`, fileRow.movie)
      hasMovies.push(photo.id)
    }
  }
  const manifest: BookBackupManifest = {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    book: { ...book, title: `${book.title || book.periodLabel} 복사본` },
    chapters,
    photos: photos.map(({ thumbnail: _thumb, ...meta }) => meta),
    layout: layout ? (({ id: _id, ...rest }) => rest)(layout) : undefined,
    cover,
    curation,
    faceGroups,
    pageNotes: pageNotes.filter(Boolean) as unknown as BookBackupManifest['pageNotes'],
    drawings: drawings.filter(Boolean) as unknown as BookBackupManifest['drawings'],
    pageCaptions: pageCaptions.filter(Boolean) as unknown as BookBackupManifest['pageCaptions'],
    pageStickers: pageStickers.filter(Boolean) as unknown as BookBackupManifest['pageStickers'],
    pageMaps: pageMaps.filter(Boolean) as unknown as BookBackupManifest['pageMaps'],
    pageFlags: pageFlags.filter(Boolean) as unknown as BookBackupManifest['pageFlags'],
    hasFiles,
    hasMovies,
  }
  zip.file('manifest.json', JSON.stringify(manifest))
  const captured = await zip.generateAsync({ type: 'blob' })
  const restoredId = await importBookBackup(
    new File([captured], 'duplicate.photobook.zip', { type: 'application/zip' }),
    onProgress,
  )
  await db.books.update(restoredId, { title: `${book.title || book.periodLabel} 복사본` })
  return restoredId
}
