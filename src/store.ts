import { create } from 'zustand'
import { db } from './db'
import { buildPages, type LayoutId } from './layout/autoLayout'
import { BOOK_SIZES } from './settings/bookSize'
import type { BookPage, BookSize, Chapter, Photo, PhotoAnalysis, PhotoCrop, PhotoFrame, PhotoSize } from './types'

const cropSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()

interface Snapshot {
  photos: Photo[]
  chapters: Chapter[]
  layoutRevision: number
  layoutOverrides: Record<string, LayoutId>
}

interface BookState {
  photos: Photo[]
  chapters: Chapter[]
  pages: BookPage[]
  selectedPageId?: string
  bookSize: BookSize
  orientation: 'portrait' | 'landscape'
  marginMm: number
  bleedMm: number
  layoutRevision: number
  layoutOverrides: Record<string, LayoutId>
  history: Snapshot[]
  setLibrary: (photos: Photo[], chapters: Chapter[]) => void
  addPhotos: (photos: Photo[]) => void
  removePhoto: (id: string) => void
  resizePhoto: (id: string, size: PhotoSize) => void
  setPhotoWeight: (id: string, weight: number) => void
  updatePhotoFrame: (id: string, frame: PhotoFrame, commit?: boolean, bringToFront?: boolean) => void
  reorderPhoto: (sourceId: string, targetId: string) => void
  setSelectedFrame: (id: string, dataUrl: string) => void
  setPhotoAnalysis: (id: string, analysis: PhotoAnalysis) => void
  setPhotoCrop: (id: string, crop: PhotoCrop) => void
  setPageLayout: (id: string, layoutId: LayoutId) => void
  regenerateLayouts: () => void
  movePhoto: (photoId: string, targetPageId: string) => void
  updateChapter: (id: string, patch: Partial<Chapter>) => void
  selectPage: (id: string) => void
  setBookSize: (size: BookSize) => void
  setOrientation: (orientation: 'portrait' | 'landscape') => void
  setPrintOptions: (marginMm: number, bleedMm: number) => void
  undo: () => void
}

function recompute(
  photos: Photo[],
  chapters: Chapter[],
  revision = 0,
  overrides: Record<string, LayoutId> = {},
) {
  return buildPages(chapters, photos, revision).map((page) => ({
    ...page,
    layoutId: overrides[page.id] ?? page.layoutId,
  }))
}

function withHistory(state: BookState) {
  return [...state.history.slice(-19), {
    photos: state.photos,
    chapters: state.chapters,
    layoutRevision: state.layoutRevision,
    layoutOverrides: state.layoutOverrides,
  }]
}

export const useBookStore = create<BookState>((set) => ({
  photos: [],
  chapters: [],
  pages: [],
  bookSize: BOOK_SIZES[0],
  orientation: 'portrait',
  marginMm: 8,
  bleedMm: 3,
  layoutRevision: 0,
  layoutOverrides: {},
  history: [],
  setLibrary: (photos, chapters) => {
    void db.chapters.bulkPut(chapters)
    const pages = recompute(photos, chapters, 0)
    set({ photos, chapters, pages, selectedPageId: pages[0]?.id, history: [], layoutRevision: 0, layoutOverrides: {} })
  },
  addPhotos: (incoming) =>
    set((state) => {
      const photos = [...state.photos, ...incoming]
      let chapters = state.chapters.map((chapter) => {
        if (chapter.type !== 'month') return chapter
        const ids = incoming
          .filter((photo) => new Date(photo.capturedAt).getMonth() + 1 === chapter.month)
          .map((photo) => photo.id)
        return { ...chapter, photoIds: [...chapter.photoIds, ...ids] }
      })
      const existingMonths = new Set(chapters.filter((chapter) => chapter.type === 'month').map((chapter) => chapter.month))
      const missingMonths = [...new Set(incoming.map((photo) => new Date(photo.capturedAt).getMonth() + 1))]
        .filter((month) => !existingMonths.has(month))
        .map((month) => {
          const monthPhotos = incoming.filter((photo) => new Date(photo.capturedAt).getMonth() + 1 === month)
          return {
            id: `month-${month}`,
            type: 'month' as const,
            month,
            title: `${month}월`,
            photoIds: monthPhotos.map((photo) => photo.id),
            note: '',
            coverPhotoId: monthPhotos[0]?.id,
          }
        })
      chapters = [...chapters, ...missingMonths].sort((a, b) => (a.month ?? 99) - (b.month ?? 99))
      void db.chapters.bulkPut(chapters)
      return { photos, chapters, pages: recompute(photos, chapters, state.layoutRevision, state.layoutOverrides), history: withHistory(state) }
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
      void db.chapters.bulkPut(chapters)
      return { photos, chapters, pages: recompute(photos, chapters, state.layoutRevision, state.layoutOverrides), history: withHistory(state) }
    }),
  resizePhoto: (id, size) =>
    set((state) => {
      const photos = state.photos.map((photo) => (photo.id === id ? { ...photo, size } : photo))
      return { photos, pages: recompute(photos, state.chapters, state.layoutRevision, state.layoutOverrides), history: withHistory(state) }
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
      const photos = state.photos.map((photo) =>
        photo.id === id
          ? {
              ...photo,
              freeFrame: frame,
              framePriority: bringToFront ? currentPriority + 1 : photo.framePriority,
              manuallyPositioned: true,
            }
          : photo,
      )
      const page = state.pages.find((candidate) => candidate.photoIds.includes(id))
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
  reorderPhoto: (sourceId, targetId) =>
    set((state) => {
      if (sourceId === targetId) return state
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
        pages = recompute(photos, chapters, state.layoutRevision, state.layoutOverrides)
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
      return { photos, pages: recompute(photos, state.chapters, state.layoutRevision, state.layoutOverrides) }
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
  setPageLayout: (id, layoutId) =>
    set((state) => {
      const layoutOverrides = { ...state.layoutOverrides, [id]: layoutId }
      return {
        layoutOverrides,
        pages: state.pages.map((page) => (page.id === id ? { ...page, layoutId } : page)),
      }
    }),
  regenerateLayouts: () =>
    set((state) => {
      const layoutRevision = state.layoutRevision + 1
      return {
        layoutRevision,
        pages: recompute(state.photos, state.chapters, layoutRevision),
        layoutOverrides: {},
        history: withHistory(state),
      }
    }),
  movePhoto: (photoId, targetPageId) =>
    set((state) => {
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
      return { chapters, pages: recompute(state.photos, chapters, state.layoutRevision, state.layoutOverrides), history: withHistory(state) }
    }),
  updateChapter: (id, patch) =>
    set((state) => {
      const chapters = state.chapters.map((chapter) => (chapter.id === id ? { ...chapter, ...patch } : chapter))
      void db.chapters.bulkPut(chapters)
      return { chapters, pages: recompute(state.photos, chapters, state.layoutRevision, state.layoutOverrides), history: withHistory(state) }
    }),
  selectPage: (selectedPageId) => set({ selectedPageId }),
  setBookSize: (bookSize) => set({ bookSize }),
  setOrientation: (orientation) => set({ orientation }),
  setPrintOptions: (marginMm, bleedMm) => set({ marginMm, bleedMm }),
  undo: () =>
    set((state) => {
      const snapshot = state.history.at(-1)
      if (!snapshot) return state
      return {
        ...snapshot,
        pages: recompute(snapshot.photos, snapshot.chapters, snapshot.layoutRevision, snapshot.layoutOverrides),
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
