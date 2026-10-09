import { create } from 'zustand'
import { selectForBook, type BookFilter } from './curate/bookSelection'
import { ensureMonthChapters } from './chapters/tripDetection'
import { db, persistCuration, saveCover, saveCurationSettings, saveDrawings, saveFaceGroups, savePageCaption, savePageNotes, syncChapters } from './db'
import { avoidObstacles, buildPages, computeAdaptiveLayout, type LayoutId } from './layout/autoLayout'
import { BOOK_SIZES } from './settings/bookSize'
import type { BookCoverDesign, BookPage, BookSize, Chapter, CurationSettings, DrawStroke, FaceGroup, FlowAspect, PageCaption, PageNote, Photo, PhotoAnalysis, PhotoCrop, PhotoFrame, PhotoSize } from './types'

const cropSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const noteSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const drawingSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const captionSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
let coverSaveTimer: ReturnType<typeof setTimeout> | undefined
const NOTE_COLORS = ['yellow', 'pink', 'blue', 'cream'] as const
const MEMO_INK: Record<(typeof NOTE_COLORS)[number], [string, string]> = {
  yellow: ['#3d3114', '#ffe58a'],
  pink: ['#5c3140', '#ffd0d8'],
  blue: ['#243e5c', '#d7ecff'],
  cream: ['#4a3b22', '#fff1d2'],
}

export const EMPTY_COVER: BookCoverDesign = {
  title: '',
  subtitle: '',
  spineText: '',
  backText: '',
  backgroundColor: '#2c2824',
  textColor: '#f6f1e8',
}

interface Snapshot {
  photos: Photo[]
  chapters: Chapter[]
  layoutRevision: number
  layoutOverrides: Record<string, LayoutId>
  flowAspectModes: Record<string, FlowAspect>
}

interface BookState {
  photos: Photo[]
  chapters: Chapter[]
  pages: BookPage[]
  pageNotes: Record<string, PageNote[]>
  drawings: Record<string, DrawStroke[]>
  pageCaptions: Record<string, PageCaption>
  cover: BookCoverDesign
  selectedPageId?: string
  bookSize: BookSize
  orientation: 'portrait' | 'landscape'
  marginMm: number
  bleedMm: number
  layoutRevision: number
  layoutOverrides: Record<string, LayoutId>
  flowAspectModes: Record<string, FlowAspect>
  history: Snapshot[]
  curation: CurationSettings
  faceGroups: FaceGroup[]
  setLibrary: (photos: Photo[], chapters: Chapter[]) => void
  applyCuration: (photos: Photo[]) => void
  includePhotos: (ids: string[]) => void
  hideDateRange: (start: string, end: string) => void
  removeHiddenRange: (id: string) => void
  setFaceGroupsEnabled: (enabled: boolean) => void
  setFaceGroups: (groups: FaceGroup[]) => void
  renameFaceGroup: (id: string, name: string) => void
  setFaceGroupHidden: (id: string, hidden: boolean) => void
  removeFacePhoto: (groupId: string, photoId: string) => void
  setPhotoText: (id: string, ocrText: string, document: boolean) => void
  addPhotos: (photos: Photo[]) => void
  removePhoto: (id: string) => void
  unplacePhoto: (id: string) => void
  removePage: (pageId: string) => void
  resizePhoto: (id: string, size: PhotoSize) => void
  setPhotoWeight: (id: string, weight: number) => void
  updatePhotoFrame: (id: string, frame: PhotoFrame, commit?: boolean, bringToFront?: boolean) => void
  updatePhotoFrames: (entries: { id: string; frame: PhotoFrame }[], commit?: boolean) => void
  setLayoutLock: (id: string, locked: boolean, frame?: PhotoFrame) => void
  reorderPhoto: (sourceId: string, targetId: string) => void
  swapPhotoPositions: (sourceId: string, targetId: string) => void
  setSelectedFrame: (id: string, dataUrl: string) => void
  setPhotoAnalysis: (id: string, analysis: PhotoAnalysis) => void
  setPhotoCrop: (id: string, crop: PhotoCrop) => void
  rotatePhoto: (id: string, delta?: 90 | -90) => void
  setPageLayout: (id: string, layoutId: LayoutId) => void
  setPageFlowAspect: (pageId: string, mode: FlowAspect) => void
  regenerateLayouts: () => void
  movePhoto: (photoId: string, targetPageId: string) => void
  addPhotoToPage: (photoId: string, pageId: string) => void
  updateChapter: (id: string, patch: Partial<Chapter>) => void
  addPageNote: (pageId: string) => void
  updatePageNote: (pageId: string, noteId: string, patch: Partial<PageNote>) => void
  removePageNote: (pageId: string, noteId: string) => void
  addStroke: (pageId: string, stroke: DrawStroke) => void
  undoStroke: (pageId: string) => void
  clearStrokes: (pageId: string) => void
  updateCover: (patch: Partial<BookCoverDesign>) => void
  updatePageCaption: (pageId: string, patch: Partial<PageCaption>) => void
  selectPage: (id: string) => void
  setBookSize: (size: BookSize) => void
  setOrientation: (orientation: 'portrait' | 'landscape') => void
  setPrintOptions: (marginMm: number, bleedMm: number) => void
  undo: () => void
}

function bookFilter(state: { curation: CurationSettings; faceGroups: FaceGroup[] }): BookFilter {
  return {
    hiddenRanges: state.curation.hiddenRanges,
    faceGroups: state.curation.faceGroupsEnabled ? state.faceGroups : [],
  }
}

function recompute(
  photos: Photo[],
  chapters: Chapter[],
  revision = 0,
  overrides: Record<string, LayoutId> = {},
  flowAspectModes: Record<string, FlowAspect> = {},
  filter: BookFilter = { hiddenRanges: [], faceGroups: [] },
) {
  const selected = selectForBook(photos, chapters, filter)
  const pages = buildPages(selected.chapters, selected.photos, revision).map((page) => ({
    ...page,
    layoutId: overrides[page.id] ?? page.layoutId,
    flowAspect: flowAspectModes[page.id] ?? 'locked',
  }))
  return { photos: selected.photos, chapters: selected.chapters, pages }
}

function lockedFrames(photos: Photo[], page: BookPage | undefined, exceptId?: string) {
  if (!page) return []
  return page.photoIds.flatMap((id) => {
    if (id === exceptId) return []
    const photo = photos.find((item) => item.id === id)
    return photo?.layoutLocked && photo.freeFrame ? [photo.freeFrame] : []
  })
}

function withHistory(state: BookState) {
  return [...state.history.slice(-19), {
    photos: state.photos,
    chapters: state.chapters,
    layoutRevision: state.layoutRevision,
    layoutOverrides: state.layoutOverrides,
    flowAspectModes: state.flowAspectModes,
  }]
}

const EMPTY_CURATION: CurationSettings = { faceGroupsEnabled: false, hiddenRanges: [] }

export const useBookStore = create<BookState>((set, get) => ({
  photos: [],
  chapters: [],
  pages: [],
  pageNotes: {},
  drawings: {},
  pageCaptions: {},
  cover: EMPTY_COVER,
  bookSize: BOOK_SIZES[0],
  orientation: 'portrait',
  marginMm: 8,
  bleedMm: 3,
  layoutRevision: 0,
  layoutOverrides: {},
  flowAspectModes: {},
  history: [],
  curation: EMPTY_CURATION,
  faceGroups: [],
  setLibrary: (photos, chapters) => {
    const nextChapters = ensureMonthChapters(photos, chapters)
    const laid = recompute(photos, nextChapters, 0, {}, {}, bookFilter(get()))
    void syncChapters(laid.chapters)
    void persistCuration(laid.photos)
    set({ ...laid, selectedPageId: laid.pages[0]?.id, history: [], layoutRevision: 0, layoutOverrides: {} })
  },
  applyCuration: (incoming) =>
    set((state) => {
      const incomingIds = new Set(incoming.map((photo) => photo.id))
      const photos = [
        ...state.photos.filter((photo) => !incomingIds.has(photo.id)),
        ...incoming,
      ].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
      const chapters = ensureMonthChapters(photos, state.chapters)
      const laid = recompute(photos, chapters, state.layoutRevision, state.layoutOverrides, state.flowAspectModes, bookFilter(state))
      void syncChapters(laid.chapters)
      void persistCuration(laid.photos)
      return { ...laid, history: withHistory(state) }
    }),
  includePhotos: (ids) =>
    set((state) => {
      const chosen = new Set(ids)
      const photos = state.photos.map((photo) => (
        chosen.has(photo.id) ? { ...photo, excludeReason: undefined, forcedIn: true, burstBest: true, omitted: false } : photo
      ))
      for (const id of ids) {
        void db.photos.where('id').equals(id).modify((row) => {
          delete row.excludeReason
          row.forcedIn = true
          row.burstBest = true
          row.omitted = false
        })
      }
      const chapters = ensureMonthChapters(photos, state.chapters)
      const laid = recompute(photos, chapters, state.layoutRevision, state.layoutOverrides, state.flowAspectModes, bookFilter(state))
      void syncChapters(laid.chapters)
      const selectedPageId = laid.pages.find((page) => page.photoIds.some((id) => chosen.has(id)))?.id ?? state.selectedPageId
      return { ...laid, history: withHistory(state), selectedPageId }
    }),
  hideDateRange: (start, end) =>
    set((state) => {
      const curation = {
        ...state.curation,
        hiddenRanges: [...state.curation.hiddenRanges, { id: `range-${Date.now().toString(36)}`, start, end }],
      }
      void saveCurationSettings(curation)
      const laid = recompute(state.photos, state.chapters, state.layoutRevision, state.layoutOverrides, state.flowAspectModes, bookFilter({ ...state, curation }))
      return { curation, ...laid }
    }),
  removeHiddenRange: (id) =>
    set((state) => {
      const curation = { ...state.curation, hiddenRanges: state.curation.hiddenRanges.filter((range) => range.id !== id) }
      void saveCurationSettings(curation)
      const laid = recompute(state.photos, state.chapters, state.layoutRevision, state.layoutOverrides, state.flowAspectModes, bookFilter({ ...state, curation }))
      return { curation, ...laid }
    }),
  setFaceGroupsEnabled: (enabled) =>
    set((state) => {
      const faceGroups = enabled ? state.faceGroups : []
      const curation = { ...state.curation, faceGroupsEnabled: enabled }
      const photos = enabled ? state.photos : state.photos.map((photo) => ({ ...photo, faceQuality: undefined }))
      void saveCurationSettings(curation)
      void saveFaceGroups(faceGroups)
      const laid = recompute(photos, state.chapters, state.layoutRevision, state.layoutOverrides, state.flowAspectModes, bookFilter({ curation, faceGroups }))
      void persistCuration(laid.photos)
      return { curation, faceGroups, ...laid }
    }),
  setFaceGroups: (faceGroups) =>
    set((state) => {
      void saveFaceGroups(faceGroups)
      const laid = recompute(state.photos, state.chapters, state.layoutRevision, state.layoutOverrides, state.flowAspectModes, bookFilter({ ...state, faceGroups }))
      return { faceGroups, ...laid }
    }),
  renameFaceGroup: (id, name) =>
    set((state) => {
      const faceGroups = state.faceGroups.map((group) => (group.id === id ? { ...group, name } : group))
      void saveFaceGroups(faceGroups)
      return { faceGroups }
    }),
  setFaceGroupHidden: (id, hidden) =>
    set((state) => {
      const faceGroups = state.faceGroups.map((group) => (group.id === id ? { ...group, hidden } : group))
      void saveFaceGroups(faceGroups)
      const laid = recompute(state.photos, state.chapters, state.layoutRevision, state.layoutOverrides, state.flowAspectModes, bookFilter({ ...state, faceGroups }))
      return { faceGroups, ...laid }
    }),
  removeFacePhoto: (groupId, photoId) =>
    set((state) => {
      const faceGroups = state.faceGroups
        .map((group) => (group.id === groupId ? { ...group, photoIds: group.photoIds.filter((id) => id !== photoId) } : group))
        .filter((group) => group.photoIds.length > 0)
      void saveFaceGroups(faceGroups)
      const laid = recompute(state.photos, state.chapters, state.layoutRevision, state.layoutOverrides, state.flowAspectModes, bookFilter({ ...state, faceGroups }))
      return { faceGroups, ...laid }
    }),
  setPhotoText: (id, ocrText, document) =>
    set((state) => {
      const current = state.photos.find((photo) => photo.id === id)
      const forced = Boolean(current?.forcedIn)
      const photos = state.photos.map((photo) => {
        if (photo.id !== id) return photo
        if (forced) return { ...photo, ocrText }
        return document ? { ...photo, ocrText, excludeReason: 'document' as const } : { ...photo, ocrText }
      })
      void db.photos.update(id, !forced && document ? { ocrText, excludeReason: 'document' } : { ocrText })
      const laid = recompute(photos, state.chapters, state.layoutRevision, state.layoutOverrides, state.flowAspectModes, bookFilter(state))
      return { ...laid }
    }),
  addPhotos: (incoming) =>
    set((state) => {
      const photos = [...state.photos, ...incoming]
      const chapters = ensureMonthChapters(photos, state.chapters)
      const laid = recompute(photos, chapters, state.layoutRevision, state.layoutOverrides, state.flowAspectModes, bookFilter(state))
      void syncChapters(laid.chapters)
      void persistCuration(laid.photos)
      return { ...laid, history: withHistory(state) }
    }),
  removePhoto: (id) =>
    set((state) => {
      const photos = state.photos.filter((photo) => photo.id !== id)
      const chapters = state.chapters.map((chapter) => ({
        ...chapter,
        photoIds: chapter.photoIds.filter((photoId) => photoId !== id),
        coverPhotoId: chapter.coverPhotoId === id ? chapter.photoIds.find((p) => p !== id) : chapter.coverPhotoId,
      }))
      void db.photos.delete(id)
      const laid = recompute(photos, chapters, state.layoutRevision, state.layoutOverrides, state.flowAspectModes, bookFilter(state))
      void syncChapters(laid.chapters)
      return { ...laid, history: withHistory(state) }
    }),
  unplacePhoto: (id) =>
    set((state) => {
      const photos = state.photos.map((photo) => (photo.id === id ? { ...photo, omitted: true } : photo))
      void db.photos.update(id, { omitted: true })
      const chapters = state.chapters
        .map((chapter) => ({
          ...chapter,
          photoIds: chapter.photoIds.filter((photoId) => photoId !== id),
          coverPhotoId: chapter.coverPhotoId === id ? undefined : chapter.coverPhotoId,
        }))
        .filter((chapter) => chapter.photoIds.length > 0)
      const chapterIds = new Set(chapters.map((chapter) => chapter.id))
      const pages = state.pages.flatMap((page) => {
        if (!chapterIds.has(page.chapterId)) return []
        if (!page.photoIds.includes(id)) return [page]
        const photoIds = page.photoIds.filter((photoId) => photoId !== id)
        if (page.type === 'photos' && !photoIds.length) return []
        return [{ ...page, photoIds }]
      })
      void syncChapters(chapters)
      return {
        photos,
        chapters,
        pages,
        selectedPageId: pages.some((page) => page.id === state.selectedPageId) ? state.selectedPageId : pages[0]?.id,
        history: withHistory(state),
      }
    }),
  removePage: (pageId) =>
    set((state) => {
      const page = state.pages.find((item) => item.id === pageId)
      if (!page) return state
      const index = state.pages.findIndex((item) => item.id === pageId)
      const removedIds = new Set(page.photoIds)
      const photos = state.photos.map((photo) => (removedIds.has(photo.id) ? { ...photo, omitted: true } : photo))
      for (const id of removedIds) void db.photos.update(id, { omitted: true })
      const chapters = state.chapters
        .map((chapter) => {
          const photoIds = chapter.photoIds.filter((id) => !removedIds.has(id))
          const onThisChapter = chapter.id === page.chapterId
          return {
            ...chapter,
            photoIds,
            coverPhotoId: chapter.coverPhotoId && removedIds.has(chapter.coverPhotoId) ? undefined : chapter.coverPhotoId,
            skipIntro: onThisChapter && page.type === 'intro' ? true : chapter.skipIntro,
            skipMap: onThisChapter && page.type === 'map' ? true : chapter.skipMap,
          }
        })
        .filter((chapter) => chapter.photoIds.length > 0)
      const chapterIds = new Set(chapters.map((chapter) => chapter.id))
      const pages = state.pages.flatMap((candidate) => {
        if (candidate.id === pageId || !chapterIds.has(candidate.chapterId)) return []
        if (!candidate.photoIds.some((id) => removedIds.has(id))) return [candidate]
        const photoIds = candidate.photoIds.filter((id) => !removedIds.has(id))
        if (candidate.type === 'photos' && !photoIds.length) return []
        return [{ ...candidate, photoIds }]
      })
      void syncChapters(chapters)
      void savePageNotes(pageId, [])
      void saveDrawings(pageId, [])
      void savePageCaption(pageId, {})
      const selectedPageId = state.selectedPageId === pageId
        ? (pages[index] ?? pages[index - 1] ?? pages[0])?.id
        : (pages.some((item) => item.id === state.selectedPageId) ? state.selectedPageId : pages[0]?.id)
      return { photos, chapters, pages, selectedPageId, history: withHistory(state) }
    }),
  resizePhoto: (id, size) =>
    set((state) => {
      const photos = state.photos.map((photo) => (photo.id === id ? { ...photo, size } : photo))
      const laid = recompute(photos, state.chapters, state.layoutRevision, state.layoutOverrides, state.flowAspectModes, bookFilter(state))
      return { ...laid, history: withHistory(state) }
    }),
  setPhotoWeight: (id, weight) =>
    set((state) => {
      const layoutWeight = Math.max(0.35, Math.min(3.5, weight))
      const photos = state.photos.map((photo) =>
        photo.id === id ? { ...photo, layoutWeight, manuallyPositioned: true } : photo,
      )
      const page = state.pages.find((candidate) => candidate.photoIds.includes(id))
      const layoutOverrides = page
        ? { ...state.layoutOverrides, [page.id]: 'adaptive-flow' as LayoutId }
        : state.layoutOverrides
      const pages = state.pages.map((candidate) =>
        candidate.id === page?.id ? { ...candidate, layoutId: 'adaptive-flow' } : candidate,
      )
      void db.photos.update(id, { layoutWeight, manuallyPositioned: true })
      return { photos, pages, layoutOverrides, history: withHistory(state) }
    }),
  updatePhotoFrame: (id, frame, commit = false, bringToFront = false) =>
    set((state) => {
      const currentPriority = Math.max(0, ...state.photos.map((photo) => photo.framePriority ?? 0))
      const page = state.pages.find((candidate) => candidate.photoIds.includes(id))
      const freeFrame = avoidObstacles(frame, lockedFrames(state.photos, page, id))
      const photos = state.photos.map((photo) =>
        photo.id === id
          ? {
              ...photo,
              freeFrame,
              framePriority: bringToFront ? currentPriority + 1 : photo.framePriority,
              manuallyPositioned: true,
            }
          : photo,
      )
      const layoutOverrides = page
        ? { ...state.layoutOverrides, [page.id]: 'adaptive-flow' as LayoutId }
        : state.layoutOverrides
      const pages = state.pages.map((candidate) =>
        candidate.id === page?.id ? { ...candidate, layoutId: 'adaptive-flow' } : candidate,
      )
      if (commit) {
        const updated = photos.find((photo) => photo.id === id)
        if (updated) {
          void db.photos.update(id, {
            freeFrame: updated.freeFrame,
            framePriority: updated.framePriority,
            manuallyPositioned: true,
          })
        }
      }
      return { photos, pages, layoutOverrides }
    }),
  updatePhotoFrames: (entries, commit = false) =>
    set((state) => {
      if (!entries.length) return state
      const byId = new Map(entries.map((entry) => [entry.id, entry.frame]))
      const page = state.pages.find((candidate) => candidate.photoIds.some((id) => byId.has(id)))
      const obstacles = lockedFrames(state.photos, page)
      const photos = state.photos.map((photo) => {
        const frame = byId.get(photo.id)
        if (!frame || photo.layoutLocked) return photo
        return { ...photo, freeFrame: avoidObstacles(frame, obstacles), manuallyPositioned: true }
      })
      const layoutOverrides = page
        ? { ...state.layoutOverrides, [page.id]: 'adaptive-flow' as LayoutId }
        : state.layoutOverrides
      const pages = state.pages.map((candidate) =>
        candidate.id === page?.id ? { ...candidate, layoutId: 'adaptive-flow' as LayoutId } : candidate,
      )
      if (commit) {
        for (const photo of photos) {
          if (!byId.has(photo.id) || photo.layoutLocked) continue
          void db.photos.update(photo.id, { freeFrame: photo.freeFrame, manuallyPositioned: true })
        }
      }
      return { photos, pages, layoutOverrides }
    }),
  setLayoutLock: (id, locked, frame) =>
    set((state) => {
      const photos = state.photos.map((photo) => {
        if (photo.id !== id) return photo
        if (!locked) return { ...photo, layoutLocked: false, freeFrame: undefined }
        return {
          ...photo,
          layoutLocked: true,
          freeFrame: frame ?? photo.freeFrame,
          manuallyPositioned: true,
        }
      })
      const page = state.pages.find((candidate) => candidate.photoIds.includes(id))
      const layoutOverrides = page
        ? { ...state.layoutOverrides, [page.id]: 'adaptive-flow' as LayoutId }
        : state.layoutOverrides
      const pages = state.pages.map((candidate) =>
        candidate.id === page?.id ? { ...candidate, layoutId: 'adaptive-flow' as LayoutId } : candidate,
      )
      const updated = photos.find((photo) => photo.id === id)
      if (updated) persistLayoutLock(id, updated)
      return { photos, pages, layoutOverrides, history: withHistory(state) }
    }),
  reorderPhoto: (sourceId, targetId) =>
    set((state) => {
      if (sourceId === targetId) return state
      if (state.photos.some((photo) => photo.id === sourceId && photo.layoutLocked)) return state
      const targetPage = state.pages.find((page) => page.photoIds.includes(targetId))
      if (!targetPage) return state
      const sourcePage = state.pages.find((page) => page.photoIds.includes(sourceId))
      const chapters = state.chapters.map((chapter) => {
        const ids = chapter.photoIds.filter((id) => id !== sourceId)
        if (chapter.id !== targetPage.chapterId) return { ...chapter, photoIds: ids }
        const targetIndex = ids.indexOf(targetId)
        ids.splice(targetIndex < 0 ? ids.length : targetIndex, 0, sourceId)
        return { ...chapter, photoIds: ids }
      })
      const photos = state.photos.map((photo) =>
        photo.id === sourceId ? { ...photo, manuallyPositioned: true } : photo,
      )
      let pages: BookPage[]
      let containingPage: BookPage | undefined
      if (sourcePage?.id === targetPage.id) {
        const orderedIds = targetPage.photoIds.filter((id) => id !== sourceId)
        orderedIds.splice(orderedIds.indexOf(targetId), 0, sourceId)
        pages = state.pages.map((page) =>
          page.id === targetPage.id
            ? { ...page, photoIds: orderedIds, layoutId: 'adaptive-flow' }
            : page,
        )
        containingPage = pages.find((page) => page.id === targetPage.id)
      } else {
        const laid = recompute(photos, chapters, state.layoutRevision, state.layoutOverrides, state.flowAspectModes, bookFilter(state))
        pages = laid.pages
        containingPage = pages.find((page) => page.photoIds.includes(sourceId))
      }
      const layoutOverrides = containingPage
        ? { ...state.layoutOverrides, [containingPage.id]: 'adaptive-flow' as LayoutId }
        : state.layoutOverrides
      pages = pages.map((page) =>
        page.id === containingPage?.id ? { ...page, layoutId: 'adaptive-flow' } : page,
      )
      void db.chapters.bulkPut(chapters)
      void db.photos.update(sourceId, { manuallyPositioned: true })
      return { photos, chapters, pages, layoutOverrides, history: withHistory(state) }
    }),
  swapPhotoPositions: (sourceId, targetId) =>
    set((state) => {
      if (sourceId === targetId) return state
      const page = state.pages.find((item) => item.type === 'photos' && item.photoIds.includes(sourceId) && item.photoIds.includes(targetId))
      if (!page) return state
      const swapIds = (ids: string[]) => {
        const first = ids.indexOf(sourceId)
        const second = ids.indexOf(targetId)
        if (first < 0 || second < 0) return ids
        const next = [...ids]
        next[first] = targetId
        next[second] = sourceId
        return next
      }
      const pages = state.pages.map((item) => (
        item.id === page.id ? { ...item, photoIds: swapIds(item.photoIds) } : item
      ))
      const chapters = state.chapters.map((chapter) => (
        chapter.id === page.chapterId ? { ...chapter, photoIds: swapIds(chapter.photoIds) } : chapter
      ))
      let photos = state.photos
      if (page.layoutId === 'adaptive-flow') {
        const items = page.photoIds.map((id) => state.photos.find((photo) => photo.id === id)).filter((photo): photo is Photo => Boolean(photo))
        const ratio = state.orientation === 'portrait'
          ? state.bookSize.widthMm / state.bookSize.heightMm
          : state.bookSize.heightMm / state.bookSize.widthMm
        const preserve = (state.flowAspectModes[page.id] ?? page.flowAspect ?? 'locked') === 'locked'
        const rects = computeAdaptiveLayout(items, ratio, preserve)
        const rectOf = new Map(items.map((photo, index) => [photo.id, photo.freeFrame ?? rects[index]]))
        const frameOfSource = rectOf.get(sourceId)
        const frameOfTarget = rectOf.get(targetId)
        photos = state.photos.map((photo) => {
          if (!page.photoIds.includes(photo.id)) return photo
          const freeFrame = photo.id === sourceId ? frameOfTarget : photo.id === targetId ? frameOfSource : rectOf.get(photo.id)
          return freeFrame ? { ...photo, freeFrame, manuallyPositioned: true } : photo
        })
        for (const photo of photos) {
          if (!page.photoIds.includes(photo.id) || !photo.freeFrame) continue
          void db.photos.update(photo.id, { freeFrame: photo.freeFrame, manuallyPositioned: true })
        }
      }
      void db.chapters.bulkPut(chapters)
      return { photos, chapters, pages, history: withHistory(state) }
    }),
  setSelectedFrame: (id, dataUrl) =>
    set((state) => {
      const photos = state.photos.map((photo) =>
        photo.id === id ? { ...photo, selectedFrame: dataUrl, thumbUrl: dataUrl, url: dataUrl } : photo,
      )
      return { photos, history: withHistory(state) }
    }),
  setPhotoAnalysis: (id, analysis) =>
    set((state) => {
      const photos = state.photos.map((photo) => (photo.id === id ? { ...photo, analysis } : photo))
      void db.photos.update(id, { analysis })
      return { photos }
    }),
  setPhotoCrop: (id, crop) =>
    set((state) => {
      const photos = state.photos.map((photo) => (photo.id === id ? { ...photo, crop } : photo))
      const existingTimer = cropSaveTimers.get(id)
      if (existingTimer) clearTimeout(existingTimer)
      cropSaveTimers.set(id, setTimeout(() => {
        void db.photos.update(id, { crop })
        cropSaveTimers.delete(id)
      }, 180))
      return { photos }
    }),
  rotatePhoto: (id, delta = 90) =>
    set((state) => {
      const photos = state.photos.map((photo) => {
        if (photo.id !== id) return photo
        const next = ((((photo.rotation ?? 0) + delta) % 360) + 360) % 360 as 0 | 90 | 180 | 270
        return { ...photo, rotation: next }
      })
      const updated = photos.find((photo) => photo.id === id)
      if (updated) void db.photos.update(id, { rotation: updated.rotation ?? 0 })
      return { photos, history: withHistory(state) }
    }),
  setPageLayout: (id, layoutId) =>
    set((state) => {
      const page = state.pages.find((candidate) => candidate.id === id)
      if (!page) return state
      const locked = page.photoIds.some((photoId) => state.photos.some((photo) => photo.id === photoId && photo.layoutLocked))
      const nextLayout = locked ? 'adaptive-flow' : layoutId
      const layoutOverrides = { ...state.layoutOverrides, [id]: nextLayout }
      const keepFrames = nextLayout === 'adaptive-flow'
      const onPage = new Set(page.photoIds)
      const photos = keepFrames
        ? state.photos
        : state.photos.map((photo) => {
            if (!onPage.has(photo.id) || photo.layoutLocked || (!photo.freeFrame && !photo.manuallyPositioned)) return photo
            return { ...photo, freeFrame: undefined, manuallyPositioned: false }
          })
      if (!keepFrames) {
        for (const photo of photos) {
          if (!onPage.has(photo.id) || photo.layoutLocked) continue
          const previous = state.photos.find((item) => item.id === photo.id)
          if (!previous?.freeFrame && !previous?.manuallyPositioned) continue
          void db.photos.where('id').equals(photo.id).modify((row) => {
            row.manuallyPositioned = false
            delete row.freeFrame
          })
        }
      }
      return {
        photos,
        layoutOverrides,
        pages: state.pages.map((candidate) => (candidate.id === id ? { ...candidate, layoutId: nextLayout } : candidate)),
      }
    }),
  setPageFlowAspect: (pageId, mode) =>
    set((state) => {
      const target = state.pages.find((page) => page.id === pageId)
      const chosen = state.layoutOverrides[pageId]
      const useFlow = target?.type === 'photos' && (!chosen || chosen === 'adaptive-flow')
      return {
        flowAspectModes: { ...state.flowAspectModes, [pageId]: mode },
        layoutOverrides: useFlow
          ? { ...state.layoutOverrides, [pageId]: 'adaptive-flow' as LayoutId }
          : state.layoutOverrides,
        pages: state.pages.map((page) => (
          page.id === pageId
            ? { ...page, flowAspect: mode, ...(useFlow ? { layoutId: 'adaptive-flow' as LayoutId } : {}) }
            : page
        )),
      }
    }),
  regenerateLayouts: () =>
    set((state) => {
      const layoutRevision = state.layoutRevision + 1
      const lockedIds = new Set(state.photos.filter((photo) => photo.layoutLocked).map((photo) => photo.id))
      if (!lockedIds.size) {
        const laid = recompute(state.photos, state.chapters, layoutRevision, {}, state.flowAspectModes, bookFilter(state))
        return {
          ...laid,
          layoutRevision,
          layoutOverrides: {},
          history: withHistory(state),
        }
      }
      const reservedIds = new Set(state.pages
        .filter((page) => page.type === 'photos' && page.photoIds.some((id) => lockedIds.has(id)))
        .flatMap((page) => page.photoIds))
      const chaptersForFlow = state.chapters.map((chapter) => ({
        ...chapter,
        photoIds: chapter.photoIds.filter((id) => !reservedIds.has(id) || id === chapter.coverPhotoId),
      }))
      const fresh = recompute(state.photos, chaptersForFlow, layoutRevision, {}, state.flowAspectModes, bookFilter(state)).pages
      const pages = state.chapters.flatMap((chapter) => {
        const freshChapter = fresh.filter((page) => page.chapterId === chapter.id)
        const fixedPages = freshChapter.filter((page) => page.type !== 'photos')
        const queue = freshChapter.filter((page) => page.type === 'photos')
        const oldPhotos = state.pages.filter((page) => page.chapterId === chapter.id && page.type === 'photos')
        const merged = oldPhotos.flatMap((page) => {
          if (page.photoIds.some((id) => lockedIds.has(id))) return [{ ...page, layoutId: 'adaptive-flow' as LayoutId }]
          const next = queue.shift()
          return next ? [next] : []
        })
        return [...fixedPages, ...merged, ...queue]
      })
      const layoutOverrides = Object.fromEntries(
        pages
          .filter((page) => page.photoIds.some((id) => lockedIds.has(id)))
          .map((page) => [page.id, 'adaptive-flow' as LayoutId]),
      )
      return { layoutRevision, pages, layoutOverrides, history: withHistory(state) }
    }),
  movePhoto: (photoId, targetPageId) =>
    set((state) => {
      if (state.photos.some((photo) => photo.id === photoId && photo.layoutLocked)) return state
      const targetPage = state.pages.find((page) => page.id === targetPageId)
      if (!targetPage) return state
      const chapters = state.chapters.map((chapter) => {
        const filtered = chapter.photoIds.filter((id) => id !== photoId)
        if (chapter.id !== targetPage.chapterId) return { ...chapter, photoIds: filtered }
        const anchor = targetPage.photoIds[0]
        const index = anchor ? filtered.indexOf(anchor) : filtered.length
        filtered.splice(index < 0 ? filtered.length : index, 0, photoId)
        return { ...chapter, photoIds: filtered }
      })
      const photos = state.photos.map((photo) => (photo.id === photoId ? { ...photo, omitted: false, forcedIn: true } : photo))
      void db.photos.update(photoId, { omitted: false, forcedIn: true })
      const laid = recompute(photos, chapters, state.layoutRevision, state.layoutOverrides, state.flowAspectModes, bookFilter(state))
      void syncChapters(laid.chapters)
      return { ...laid, history: withHistory(state) }
    }),
  addPhotoToPage: (photoId, pageId) =>
    set((state) => {
      const targetPage = state.pages.find((page) => page.id === pageId)
      if (!targetPage || targetPage.type !== 'photos' || targetPage.photoIds.includes(photoId)) return state
      const chapters = state.chapters
        .map((chapter) => {
          const without = chapter.photoIds.filter((id) => id !== photoId)
          if (chapter.id !== targetPage.chapterId) {
            return {
              ...chapter,
              photoIds: without,
              coverPhotoId: chapter.coverPhotoId === photoId ? without[0] : chapter.coverPhotoId,
            }
          }
          const anchor = targetPage.photoIds.at(-1)
          const index = anchor ? without.indexOf(anchor) : -1
          const photoIds = [...without]
          photoIds.splice(index < 0 ? photoIds.length : index + 1, 0, photoId)
          return { ...chapter, photoIds }
        })
        .filter((chapter) => chapter.photoIds.length > 0)
      const chapterIds = new Set(chapters.map((chapter) => chapter.id))
      const layoutOverrides = { ...state.layoutOverrides, [targetPage.id]: 'adaptive-flow' as LayoutId }
      const pages = state.pages.flatMap((page) => {
        if (!chapterIds.has(page.chapterId)) return []
        if (page.type === 'intro') {
          const chapter = chapters.find((item) => item.id === page.chapterId)
          return [{ ...page, photoIds: chapter?.coverPhotoId ? [chapter.coverPhotoId] : [] }]
        }
        if (page.id === targetPage.id) return [{ ...page, photoIds: [...page.photoIds, photoId], layoutId: 'adaptive-flow' as LayoutId }]
        if (!page.photoIds.includes(photoId)) return [page]
        const photoIds = page.photoIds.filter((id) => id !== photoId)
        return page.type === 'photos' && !photoIds.length ? [] : [{ ...page, photoIds }]
      })
      const photos = state.photos.map((photo) => (
        photo.id === photoId
          ? { ...photo, omitted: false, manuallyPositioned: true, forcedIn: true, excludeReason: undefined, burstBest: true }
          : photo
      ))
      void db.photos.where('id').equals(photoId).modify((row) => {
        row.omitted = false
        row.manuallyPositioned = true
        row.forcedIn = true
        row.burstBest = true
        delete row.excludeReason
      })
      void syncChapters(chapters)
      return { photos, chapters, pages, layoutOverrides, history: withHistory(state) }
    }),
  updateChapter: (id, patch) =>
    set((state) => {
      const nextPatch = patch.coverPhotoId ? { ...patch, coverManual: true } : patch
      const chapters = state.chapters.map((chapter) => (chapter.id === id ? { ...chapter, ...nextPatch } : chapter))
      const laid = recompute(state.photos, chapters, state.layoutRevision, state.layoutOverrides, state.flowAspectModes, bookFilter(state))
      void syncChapters(laid.chapters)
      return { ...laid, history: withHistory(state) }
    }),
  addPageNote: (pageId) =>
    set((state) => {
      const existing = state.pageNotes[pageId] ?? []
      const offset = (existing.length % 4) * 0.05
      const tone = NOTE_COLORS[existing.length % NOTE_COLORS.length]
      const note: PageNote = {
        id: `note-${Date.now().toString(36)}-${existing.length}`,
        kind: 'memo',
        text: '메모',
        x: Math.min(0.72, 0.56 + offset),
        y: Math.min(0.72, 0.56 + offset),
        color: tone,
        textColor: MEMO_INK[tone][0],
        backgroundColor: MEMO_INK[tone][1],
        backgroundAlpha: 1,
        width: 0.3,
        height: 0.24,
      }
      const notes = [...existing, note]
      void savePageNotes(pageId, notes)
      return { pageNotes: { ...state.pageNotes, [pageId]: notes } }
    }),
  updatePageNote: (pageId, noteId, patch) =>
    set((state) => {
      const notes = (state.pageNotes[pageId] ?? []).map((note) => (note.id === noteId ? { ...note, ...patch } : note))
      const pending = noteSaveTimers.get(pageId)
      if (pending) clearTimeout(pending)
      noteSaveTimers.set(pageId, setTimeout(() => { void savePageNotes(pageId, notes) }, 250))
      return { pageNotes: { ...state.pageNotes, [pageId]: notes } }
    }),
  removePageNote: (pageId, noteId) =>
    set((state) => {
      const notes = (state.pageNotes[pageId] ?? []).filter((note) => note.id !== noteId)
      const pending = noteSaveTimers.get(pageId)
      if (pending) clearTimeout(pending)
      void savePageNotes(pageId, notes)
      return { pageNotes: { ...state.pageNotes, [pageId]: notes } }
    }),
  addStroke: (pageId, stroke) =>
    set((state) => {
      const strokes = [...(state.drawings[pageId] ?? []), stroke]
      scheduleDrawings(pageId, strokes)
      return { drawings: { ...state.drawings, [pageId]: strokes } }
    }),
  undoStroke: (pageId) =>
    set((state) => {
      const strokes = (state.drawings[pageId] ?? []).slice(0, -1)
      scheduleDrawings(pageId, strokes)
      return { drawings: { ...state.drawings, [pageId]: strokes } }
    }),
  clearStrokes: (pageId) =>
    set((state) => {
      scheduleDrawings(pageId, [])
      return { drawings: { ...state.drawings, [pageId]: [] } }
    }),
  updateCover: (patch) =>
    set((state) => {
      const cover = { ...state.cover, ...patch }
      if (coverSaveTimer) clearTimeout(coverSaveTimer)
      coverSaveTimer = setTimeout(() => { void saveCover(cover) }, 250)
      return { cover }
    }),
  updatePageCaption: (pageId, patch) =>
    set((state) => {
      const caption = { ...state.pageCaptions[pageId], ...patch }
      const pending = captionSaveTimers.get(pageId)
      if (pending) clearTimeout(pending)
      captionSaveTimers.set(pageId, setTimeout(() => { void savePageCaption(pageId, caption) }, 250))
      return { pageCaptions: { ...state.pageCaptions, [pageId]: caption } }
    }),
  selectPage: (selectedPageId) => set({ selectedPageId }),
  setBookSize: (bookSize) => set({ bookSize }),
  setOrientation: (orientation) => set({ orientation }),
  setPrintOptions: (marginMm, bleedMm) => set({ marginMm, bleedMm }),
  undo: () =>
    set((state) => {
      const snapshot = state.history.at(-1)
      if (!snapshot) return state
      void syncChapters(snapshot.chapters)
      for (const photo of snapshot.photos) {
        void db.photos.update(photo.id, { omitted: Boolean(photo.omitted) })
        persistLayoutLock(photo.id, photo)
      }
      const laid = recompute(snapshot.photos, snapshot.chapters, snapshot.layoutRevision, snapshot.layoutOverrides, snapshot.flowAspectModes ?? {}, bookFilter(state))
      return {
        ...snapshot,
        ...laid,
        flowAspectModes: snapshot.flowAspectModes ?? {},
        layoutRevision: snapshot.layoutRevision,
        layoutOverrides: snapshot.layoutOverrides,
        history: state.history.slice(0, -1),
      }
    }),
}))

export function currentState() {
  return getSafeState()
}

function getSafeState() {
  return useBookStore.getState()
}

function persistLayoutLock(id: string, photo: Photo) {
  void db.photos.update(id, {
    layoutLocked: Boolean(photo.layoutLocked),
    manuallyPositioned: Boolean(photo.manuallyPositioned),
    ...(photo.freeFrame ? { freeFrame: photo.freeFrame } : {}),
  })
  if (!photo.freeFrame) {
    void db.photos.where('id').equals(id).modify((row) => { delete row.freeFrame })
  }
}

function scheduleDrawings(pageId: string, strokes: DrawStroke[]) {
  const pending = drawingSaveTimers.get(pageId)
  if (pending) clearTimeout(pending)
  drawingSaveTimers.set(pageId, setTimeout(() => { void saveDrawings(pageId, strokes) }, 250))
}
