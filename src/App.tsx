import {
  Archive, BookOpen, Check, ChevronLeft, ChevronRight, ChevronsLeft, Copy, Download, FolderOpen, Home, ImagePlus, LogOut, Pencil,
  Crop, Grip, LayoutTemplate, Lock, MapPinned, Maximize2, Minus, Mountain, Plus, RotateCcw, RotateCw, Settings2, Sparkles,
  Trash2, Upload, Users, WandSparkles, X,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import 'leaflet/dist/leaflet.css'
import './App.css'
import { useAuth } from './auth/AuthContext'
import { buildChapters, cachedPlace, placeName } from './chapters/tripDetection'
import { analyzePhoto } from './classify/analyzePhoto'
import { CoverDecorPicker, PageDecorPicker } from './components/DecorPicker'
import { FrameLayer } from './components/FrameLayer'
import { InvitesPanel } from './components/InvitesPanel'
import { LivePhotoPicker } from './components/LivePhotoPicker'
import { MemoriesPanel } from './components/MemoriesPanel'
import { TripMap } from './components/TripMap'
import { EMPTY_FRAME } from './decorate/frames'
import { groupFaces } from './curate/faces'
import { scanDocuments } from './curate/ocr'
import { SIGNALS_VERSION, curatePhotos, scoreQuality } from './curate/signals'
import {
  attachPhotoBinaries, attachPhotoBinary, createBook, deleteBook, getActiveBookId, listBooks, loadBookWorkspace,
  revokePhotoUrls, saveCurationSettings, savePageNotes, setActiveBookId, syncBookMetaFromPhotos, updateBookMeta,
  type BookListItem,
} from './db'
import { STICKER_EMOJIS } from './stickers'
import { duplicateBook, exportBookBackup, importBookBackup } from './export/backup'
import { exportBookPdf, preparePrintUrls, revokePrintUrls, waitForExportImages } from './export/pdf'
import { chooseDirectoryFiles, scanFiles, type ImportSkip } from './import/scanFolder'
import { availableLayouts, computeAdaptiveLayout, findPhotoGutters, YEAR_CHAPTER_ID, type LayoutId, type PhotoGutter } from './layout/autoLayout'
import { BOOK_SIZES, MAX_PAGES, coverSpread } from './settings/bookSize'
import { EMPTY_COVER, useBookStore } from './store'
import type { BookPage, Chapter, CoverPanel, CoverSticker, ExcludeReason, HoldReason, ImportProgress, PageCaption, PageMapWidget, PageNote, PageSticker, Photo, PhotoFrame } from './types'

const THUMB_SIZES = [56, 72, 88, 108, 132]
const TEMPLATE_SIZES = [68, 88, 108, 132, 160]
const DEFAULT_THUMB = 72
const DEFAULT_TEMPLATE = 88
const TRAY_GAP = 7
const TRAY_CHROME = 52

function trayWidthForColumns(size: number, columns = 5) {
  return size * columns + TRAY_GAP * (columns - 1) + TRAY_CHROME
}

function storedNumber(key: string, fallback: number) {
  const value = Number(localStorage.getItem(key))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const CURRENT_YEAR = new Date().getFullYear()

function App() {
  const { user, signOutUser } = useAuth()
  // drawings/history는 편집 중 자주 바뀌므로 App 전체 리렌더에서 제외
  const store = useBookStore(useShallow(({ drawings: _d, history: _h, ...rest }) => rest))
  const setLibrary = useBookStore((state) => state.setLibrary)
  const [progress, setProgress] = useState<ImportProgress>()
  const [importError, setImportError] = useState('')
  const [importSkips, setImportSkips] = useState<ImportSkip[]>([])
  const [livePhoto, setLivePhoto] = useState<Photo>()
  const [cropPhotoId, setCropPhotoId] = useState<string>()
  const [selectedCanvasPhotoId, setSelectedCanvasPhotoId] = useState<string>()
  const placeKey = store.photos
    .map((photo) => (photo.latitude == null || photo.longitude == null ? '' : `${photo.latitude.toFixed(2)},${photo.longitude.toFixed(2)}`))
    .filter(Boolean)
    .join('|')
  const [placeRevision, setPlaceRevision] = useState(0)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sidePanel, setSidePanel] = useState<'pages' | 'memories'>('pages')
  const [faceProgress, setFaceProgress] = useState(0)
  const [analysisProgress, setAnalysisProgress] = useState(0)
  const [exportLabel, setExportLabel] = useState('')
  const [printUrls, setPrintUrls] = useState<Record<string, string>>({})
  const [customSize, setCustomSize] = useState({ widthMm: 210, heightMm: 297 })
  const [restoring, setRestoring] = useState(true)
  const [showWelcome, setShowWelcome] = useState(true)
  const [bookList, setBookList] = useState<BookListItem[]>([])
  const [openingBookId, setOpeningBookId] = useState<string>()
  const [deletingBookId, setDeletingBookId] = useState<string>()
  const [shelfBusyId, setShelfBusyId] = useState<string>()
  const [shelfStatus, setShelfStatus] = useState('')
  const [thumbSize, setThumbSize] = useState(() => storedNumber('photobook-thumb-size', DEFAULT_THUMB))
  const [templateSize, setTemplateSize] = useState(() => {
    const stored = storedNumber('photobook-template-size', DEFAULT_TEMPLATE)
    return TEMPLATE_SIZES.includes(stored) ? stored : DEFAULT_TEMPLATE
  })
  const [trayWidth, setTrayWidth] = useState(() => storedNumber('photobook-tray-width', trayWidthForColumns(DEFAULT_THUMB)))
  const [coverMode, setCoverMode] = useState(false)
  const [drawMode, setDrawMode] = useState(false)
  const [decorOpen, setDecorOpen] = useState(false)
  const [stickerPicker, setStickerPicker] = useState<'page' | CoverPanel | null>(null)
  const [penColor, setPenColor] = useState('#2b2824')
  const [penSize, setPenSize] = useState(1.2)
  const [trayDragging, setTrayDragging] = useState(false)
  const [trashHot, setTrashHot] = useState(false)
  const [traySelected, setTraySelected] = useState<string[]>([])
  const [trayPreviewId, setTrayPreviewId] = useState<string | undefined>()
  const [deleteConfirm, setDeleteConfirm] = useState<{ ids: string[]; title: string; body: string } | null>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const backupInputRef = useRef<HTMLInputElement>(null)
  const addInputRef = useRef<HTMLInputElement>(null)
  const trayListRef = useRef<HTMLDivElement>(null)
  const pageListRef = useRef<HTMLDivElement>(null)
  const trayAnchorRef = useRef<string | null>(null)
  const marqueeBoxRef = useRef<HTMLDivElement>(null)
  const marqueeRafRef = useRef(0)
  const marqueeKeyRef = useRef('')
  const marqueeRef = useRef<{
    pointerId: number
    originX: number
    originY: number
    additive: boolean
    baseline: Set<string>
    currentIds: string[]
  } | null>(null)

  const selectedIndex = Math.max(0, store.pages.findIndex((page) => page.id === store.selectedPageId))
  const selectedPage = store.pages[selectedIndex]
  const selectedChapter = store.chapters.find((chapter) => chapter.id === selectedPage?.chapterId)
  const pagePlacements = useMemo(() => pagePlacementByPhoto(store.pages), [store.pages])
  const trayEntries = useMemo(() => libraryEntries(store.photos), [store.photos])
  const traySelectedSet = useMemo(() => new Set(traySelected), [traySelected])
  const onCanvasIds = useMemo(() => new Set(selectedPage?.photoIds ?? []), [selectedPage?.photoIds])
  const pageCompleted = Boolean(selectedPage && store.completedPages[selectedPage.id])
  const bookYear = store.photos.length ? bookYearFromPhotos(store.photos) : CURRENT_YEAR
  const bookPeriod = store.photos.length ? existingBookPeriod(store.photos) : ''

  async function refreshBookList() {
    const next = await listBooks()
    setBookList((previous) => {
      for (const item of previous) {
        if (item.coverThumbUrl?.startsWith('blob:')) {
          try { URL.revokeObjectURL(item.coverThumbUrl) } catch { /* ignore */ }
        }
      }
      return next
    })
  }

  function emptyEditorState() {
    return {
      photos: [] as Photo[],
      chapters: [] as Chapter[],
      pages: [],
      pageNotes: {},
      drawings: {},
      pageCaptions: {},
      pageStickers: {},
      pageMaps: {},
      cover: EMPTY_COVER,
      pageFrame: { ...EMPTY_FRAME },
      completedPages: {},
      faceGroups: [],
      curation: { faceGroupsEnabled: false, hiddenRanges: [], focusFaceIds: [] },
      history: [],
      layoutRevision: 0,
      layoutOverrides: {},
      flowAspectModes: {},
      selectedPageId: undefined as string | undefined,
    }
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const books = await listBooks()
        if (cancelled) return
        setBookList(books)
        setShowWelcome(true)
      } catch (error) {
        console.warn('포토북 목록을 불러오지 못했습니다.', error)
      } finally {
        if (!cancelled) setRestoring(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  async function openBook(bookId: string) {
    setOpeningBookId(bookId)
    setImportError('')
    try {
      revokePhotoUrls(useBookStore.getState().photos)
      const workspace = await loadBookWorkspace(bookId)
      const { library, bookLayout, pageNotes, drawings, cover, pageCaptions, curation, faceGroups, pageStickers, pageMaps, completedPages } = workspace
      if (!library.photos.length) {
        setImportError('이 포토북에 사진이 없습니다.')
        return
      }
      const memos = Object.fromEntries(Object.entries(pageNotes).map(([pageId, notes]) => {
        const kept = notes.filter((note) => note.kind === 'memo')
        if (kept.length !== notes.length) void savePageNotes(pageId, kept)
        return [pageId, kept]
      }))
      useBookStore.setState({
        ...emptyEditorState(),
        pageNotes: memos,
        drawings,
        pageCaptions,
        pageStickers,
        pageMaps,
        curation,
        faceGroups,
        completedPages,
        ...(cover ? {
          cover: {
            ...EMPTY_COVER,
            ...cover,
            stickers: cover.stickers ?? [],
            frame: cover.frame ? { ...EMPTY_FRAME, ...cover.frame } : EMPTY_COVER.frame,
          },
        } : {}),
        pageFrame: bookLayout?.pageFrame
          ? { ...EMPTY_FRAME, ...bookLayout.pageFrame }
          : { ...EMPTY_FRAME },
      })
      if (bookLayout?.pages?.length) {
        useBookStore.setState({
          photos: library.photos,
          chapters: library.chapters,
          completedPages,
        })
        useBookStore.getState().restoreBookLayout(bookLayout)
      } else {
        setLibrary(library.photos, library.chapters)
        useBookStore.setState({ completedPages })
      }
      setShowWelcome(false)
      if ((curation.signalsVersion ?? 0) < SIGNALS_VERSION) {
        void (async () => {
          try {
            const curated = await curatePhotos(useBookStore.getState().photos)
            const nextCuration = { ...useBookStore.getState().curation, signalsVersion: SIGNALS_VERSION }
            useBookStore.getState().patchPhotoSignals(curated)
            useBookStore.setState({ curation: nextCuration })
            await saveCurationSettings(nextCuration)
          } catch (error) {
            console.warn('사진 신호 재계산을 건너뜁니다.', error)
          }
        })()
      }
    } catch (error) {
      console.warn('포토북을 열지 못했습니다.', error)
      setImportError('포토북을 열지 못했습니다. 잠시 후 다시 시도해주세요.')
    } finally {
      setOpeningBookId(undefined)
    }
  }

  async function goHome() {
    const bookId = getActiveBookId()
    const photos = useBookStore.getState().photos
    if (bookId && photos.length) {
      await syncBookMetaFromPhotos(bookId, photos)
    }
    await refreshBookList()
    setShowWelcome(true)
    setCoverMode(false)
    setDecorOpen(false)
    setTraySelected([])
    setTrayPreviewId(undefined)
  }

  async function removeBookFromList(bookId: string) {
    setDeletingBookId(bookId)
    try {
      if (getActiveBookId() === bookId) {
        revokePhotoUrls(useBookStore.getState().photos)
        useBookStore.setState(emptyEditorState())
        setActiveBookId(undefined)
      }
      await deleteBook(bookId)
      await refreshBookList()
    } catch (error) {
      console.warn('포토북을 삭제하지 못했습니다.', error)
      setImportError('포토북을 삭제하지 못했습니다.')
    } finally {
      setDeletingBookId(undefined)
    }
  }

  async function renameBookOnShelf(book: BookListItem) {
    const next = window.prompt('포토북 이름', book.title || book.periodLabel)
    if (next == null) return
    const title = next.trim()
    if (!title || title === (book.title || book.periodLabel)) return
    setShelfBusyId(book.id)
    setShelfStatus('이름 바꾸는 중…')
    try {
      await updateBookMeta(book.id, { title })
      await refreshBookList()
      setShelfStatus('이름을 바꿨습니다.')
    } catch (error) {
      console.warn('이름 변경 실패', error)
      setImportError('포토북 이름을 바꾸지 못했습니다.')
    } finally {
      setShelfBusyId(undefined)
    }
  }

  async function backupBookOnShelf(bookId: string) {
    setShelfBusyId(bookId)
    setShelfStatus('백업 준비 중…')
    try {
      await exportBookBackup(bookId, setShelfStatus)
      setShelfStatus('백업 파일을 저장했습니다.')
    } catch (error) {
      console.warn('백업 실패', error)
      setImportError(error instanceof Error ? error.message : '백업에 실패했습니다.')
      setShelfStatus('')
    } finally {
      setShelfBusyId(undefined)
    }
  }

  async function duplicateBookOnShelf(bookId: string) {
    setShelfBusyId(bookId)
    setShelfStatus('복제 중…')
    try {
      await duplicateBook(bookId, setShelfStatus)
      await refreshBookList()
      setShelfStatus('복사본을 만들었습니다.')
    } catch (error) {
      console.warn('복제 실패', error)
      setImportError(error instanceof Error ? error.message : '복제에 실패했습니다.')
      setShelfStatus('')
    } finally {
      setShelfBusyId(undefined)
    }
  }

  async function restoreBookBackup(file: File) {
    setImportError('')
    setShelfStatus('백업 복원 중…')
    setShelfBusyId('restore')
    try {
      const bookId = await importBookBackup(file, setShelfStatus)
      await refreshBookList()
      setShelfStatus('복원이 완료되었습니다. 책을 열어보세요.')
      await openBook(bookId)
    } catch (error) {
      console.warn('복원 실패', error)
      setImportError(error instanceof Error ? error.message : '백업을 복원하지 못했습니다.')
      setShelfStatus('')
    } finally {
      setShelfBusyId(undefined)
    }
  }

  async function startNewBook(files: File[]) {
    if (!files.length) return
    setImportError('')
    setImportSkips([])
    let createdId: string | undefined
    try {
      const currentId = getActiveBookId()
      const currentPhotos = useBookStore.getState().photos
      if (currentId && currentPhotos.length) {
        await syncBookMetaFromPhotos(currentId, currentPhotos)
      }
      revokePhotoUrls(currentPhotos)
      useBookStore.setState(emptyEditorState())
      const created = await createBook({ year: CURRENT_YEAR, title: '새 포토북' })
      createdId = created.id
      await importFiles(files, true)
      const bookId = getActiveBookId()
      if (bookId) await syncBookMetaFromPhotos(bookId, useBookStore.getState().photos)
      await refreshBookList()
    } catch (error) {
      if (createdId && !useBookStore.getState().photos.length) {
        try {
          await deleteBook(createdId)
          setActiveBookId(undefined)
        } catch { /* ignore */ }
        await refreshBookList()
      }
      setImportError(error instanceof Error ? error.message : '새 포토북을 만들지 못했습니다.')
    }
  }

  useEffect(() => {
    const keys = [...new Set(placeKey.split('|').filter(Boolean))]
    let cancel = false
    void (async () => {
      for (const key of keys) {
        if (localStorage.getItem(`place:${key}`)) continue
        if (cancel) return
        const [lat, lon] = key.split(',').map(Number)
        await placeName(lat, lon)
        if (!cancel) setPlaceRevision((value) => value + 1)
      }
    })()
    return () => { cancel = true }
  }, [placeKey])

  useEffect(() => {
    const list = trayListRef.current
    if (!list || !selectedPage?.photoIds.length) return
    const target = [...list.querySelectorAll<HTMLElement>('.tray-photo')]
      .find((node) => selectedPage.photoIds.includes(node.dataset.photoId ?? ''))
    if (!target) return
    const delta = target.getBoundingClientRect().top - list.getBoundingClientRect().top
    list.scrollTo({ top: Math.max(0, list.scrollTop + delta - 36), behavior: 'smooth' })
  }, [selectedPage?.id, selectedPage?.photoIds.join('|')])

  useEffect(() => {
    const list = pageListRef.current
    if (!list) return
    const target = list.querySelector<HTMLElement>('.page-thumb.active')
    if (!target) return
    const listRect = list.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    if (targetRect.top >= listRect.top + 4 && targetRect.bottom <= listRect.bottom - 4) return
    const top = targetRect.top < listRect.top
      ? list.scrollTop + targetRect.top - listRect.top - 8
      : list.scrollTop + targetRect.bottom - listRect.bottom + 8
    list.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }, [selectedPage?.id, coverMode])

  async function importFiles(files: File[], replace = true) {
    if (!files.length) return
    setImportError('')
    if (replace) setImportSkips([])
    try {
      if (replace && !getActiveBookId()) {
        await createBook({ year: CURRENT_YEAR, title: '새 포토북' })
      }
      if (!getActiveBookId()) throw new Error('활성 포토북이 없습니다.')
      const existing = replace ? [] : useBookStore.getState().photos
      const preferredYear = replace ? undefined : (existing.length ? bookYearFromPhotos(existing) : undefined)
      const scanned = await scanFiles(files, setProgress, { year: preferredYear })
      setImportSkips((previous) => (replace ? scanned.skips : [...previous, ...scanned.skips]))
      if (!scanned.photos.length) {
        const skipHint = scanned.skips.length
          ? `\n건너뛴 파일 ${scanned.skips.length}개`
          : ''
        throw new Error((preferredYear
          ? `${preferredYear}년에 촬영한 사진을 찾지 못했습니다.`
          : '가져올 사진을 찾지 못했습니다.') + skipHint)
      }
      const curated = await curatePhotos([...existing, ...scanned.photos], (current, total) => {
        setProgress({ current, total, label: '사진을 고르는 중' })
      })
      if (replace) {
        setProgress({ current: 1, total: 1, label: '여행과 월별 챕터를 구성하는 중' })
        const chapters = await buildChapters(curated)
        store.setLibrary(curated, chapters)
        setShowWelcome(false)
      } else {
        store.applyCuration(curated)
      }
      const curation = { ...useBookStore.getState().curation, signalsVersion: SIGNALS_VERSION }
      useBookStore.setState({ curation })
      void saveCurationSettings(curation)
      void scanDocuments(useBookStore.getState().photos, (id, text, document) => {
        useBookStore.getState().setPhotoText(id, text, document)
      })
      if (scanned.skips.length) {
        setImportError(`${scanned.photos.length}장을 가져왔고, ${scanned.skips.length}개는 건너뛰었습니다.`)
      }
    } catch (error) {
      setImportError(error instanceof Error ? error.message : '사진을 가져오지 못했습니다.')
      throw error instanceof Error ? error : new Error('사진을 가져오지 못했습니다.')
    } finally {
      setProgress(undefined)
    }
  }

  async function toggleFaceGroups(enabled: boolean) {
    if (!enabled) {
      store.setFaceGroupsEnabled(false)
      return
    }
    store.setFaceGroupsEnabled(true)
    setFaceProgress(1)
    try {
      const { groups, quality } = await groupFaces(useBookStore.getState().photos, [], (current, total) => {
        setFaceProgress(Math.round((current / Math.max(total, 1)) * 100))
      })
      const photos = useBookStore.getState().photos.map((photo) => {
        const faceQuality = quality.get(photo.id)
        if (faceQuality == null) return photo
        const next = { ...photo, faceQuality }
        return { ...next, quality: scoreQuality(next) }
      })
      useBookStore.getState().applyCuration(photos)
      useBookStore.getState().setFaceGroups(groups)
    } catch (error) {
      console.warn('얼굴 그룹을 만들지 못했습니다.', error)
      setImportError('얼굴 그룹 모델을 불러오지 못했습니다. 인터넷에 연결된 뒤 다시 켜 주세요.')
    } finally {
      setFaceProgress(0)
    }
  }

  function libraryPhotoIds() {
    return trayEntries
      .filter((entry): entry is { type: 'photo'; photo: Photo } => entry.type === 'photo')
      .map((entry) => entry.photo.id)
  }

  function selectTrayPhotos(ids: string[], anchor?: string) {
    setTraySelected(ids)
    if (anchor !== undefined) trayAnchorRef.current = anchor
    else if (ids.length === 1) trayAnchorRef.current = ids[0]
  }

  function paintTraySelection(ids: string[]) {
    const list = trayListRef.current
    if (!list) return
    const selected = new Set(ids)
    for (const node of list.querySelectorAll<HTMLElement>('.tray-photo-wrap')) {
      const on = Boolean(node.dataset.photoId && selected.has(node.dataset.photoId))
      node.classList.toggle('is-selected', on)
      node.querySelector('.tray-photo')?.classList.toggle('is-selected', on)
    }
  }

  function toggleTrayPhoto(photoId: string, event: React.MouseEvent) {
    if (event.metaKey || event.ctrlKey) {
      const next = new Set(traySelected)
      if (next.has(photoId)) next.delete(photoId)
      else next.add(photoId)
      selectTrayPhotos([...next], photoId)
      return
    }
    if (event.shiftKey && trayAnchorRef.current) {
      const order = libraryPhotoIds()
      const from = order.indexOf(trayAnchorRef.current)
      const to = order.indexOf(photoId)
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from < to ? [from, to] : [to, from]
        selectTrayPhotos(order.slice(lo, hi + 1))
        return
      }
    }
    selectTrayPhotos([photoId], photoId)
    const placement = pagePlacements.get(photoId)
    if (placement) {
      setCoverMode(false)
      store.selectPage(placement.pageId)
    }
  }

  function photosInMarquee(box: { left: number; top: number; width: number; height: number }) {
    const list = trayListRef.current
    if (!list) return [] as string[]
    const listRect = list.getBoundingClientRect()
    const sel = {
      left: box.left,
      top: box.top,
      right: box.left + box.width,
      bottom: box.top + box.height,
    }
    const hits: string[] = []
    for (const node of list.querySelectorAll<HTMLElement>('.tray-photo-wrap')) {
      const id = node.dataset.photoId
      if (!id) continue
      const rect = node.getBoundingClientRect()
      const left = rect.left - listRect.left + list.scrollLeft
      const top = rect.top - listRect.top + list.scrollTop
      const right = left + rect.width
      const bottom = top + rect.height
      if (left < sel.right && right > sel.left && top < sel.bottom && bottom > sel.top) hits.push(id)
    }
    return hits
  }

  function hideTrayMarqueeBox() {
    const box = marqueeBoxRef.current
    if (!box) return
    box.hidden = true
    box.style.width = '0'
    box.style.height = '0'
  }

  function beginTrayMarquee(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('.tray-photo-wrap, .tray-delete, .tray-zoom, .tray-selection-bar')) return
    const list = trayListRef.current
    if (!list) return
    event.preventDefault()
    list.setPointerCapture(event.pointerId)
    const rect = list.getBoundingClientRect()
    const originX = event.clientX - rect.left + list.scrollLeft
    const originY = event.clientY - rect.top + list.scrollTop
    const additive = event.metaKey || event.ctrlKey
    const baseline = new Set(additive ? traySelected : [])
    marqueeRef.current = {
      pointerId: event.pointerId,
      originX,
      originY,
      additive,
      baseline,
      currentIds: additive ? [...baseline] : [],
    }
    marqueeKeyRef.current = ''
    const box = marqueeBoxRef.current
    if (box) {
      box.hidden = false
      box.style.left = `${originX}px`
      box.style.top = `${originY}px`
      box.style.width = '0'
      box.style.height = '0'
    }
    if (!additive) {
      selectTrayPhotos([])
      paintTraySelection([])
    }
  }

  function moveTrayMarquee(event: React.PointerEvent<HTMLDivElement>) {
    const session = marqueeRef.current
    if (!session || session.pointerId !== event.pointerId) return
    const list = trayListRef.current
    if (!list) return
    const rect = list.getBoundingClientRect()
    const x = event.clientX - rect.left + list.scrollLeft
    const y = event.clientY - rect.top + list.scrollTop
    const box = {
      left: Math.min(session.originX, x),
      top: Math.min(session.originY, y),
      width: Math.abs(x - session.originX),
      height: Math.abs(y - session.originY),
    }
    const boxEl = marqueeBoxRef.current
    if (boxEl) {
      boxEl.style.left = `${box.left}px`
      boxEl.style.top = `${box.top}px`
      boxEl.style.width = `${box.width}px`
      boxEl.style.height = `${box.height}px`
    }
    if (marqueeRafRef.current) cancelAnimationFrame(marqueeRafRef.current)
    marqueeRafRef.current = requestAnimationFrame(() => {
      marqueeRafRef.current = 0
      const active = marqueeRef.current
      if (!active) return
      const hits = photosInMarquee(box)
      const next = active.additive ? [...new Set([...active.baseline, ...hits])] : hits
      const key = next.join('\0')
      if (key === marqueeKeyRef.current) return
      marqueeKeyRef.current = key
      active.currentIds = next
      paintTraySelection(next)
    })
  }

  function endTrayMarquee(event: React.PointerEvent<HTMLDivElement>) {
    const session = marqueeRef.current
    if (!session || session.pointerId !== event.pointerId) return
    if (marqueeRafRef.current) {
      cancelAnimationFrame(marqueeRafRef.current)
      marqueeRafRef.current = 0
    }
    marqueeRef.current = null
    hideTrayMarqueeBox()
    selectTrayPhotos(session.currentIds)
    try {
      trayListRef.current?.releasePointerCapture(event.pointerId)
    } catch {
      /* ignore */
    }
  }

  function removeFromLibrary(photoIds: string[]) {
    const ids = [...new Set(photoIds)].filter((id) => store.photos.some((photo) => photo.id === id))
    if (!ids.length) return
    const anyPlaced = ids.some((id) => pagePlacements.has(id))
    setDeleteConfirm({
      ids,
      title: ids.length > 1 ? `선택한 ${ids.length}장을 뺄까요?` : '이 사진을 뺄까요?',
      body: anyPlaced
        ? '책에 들어간 사진도 함께 빠집니다. 기기·폴더의 원본 파일은 삭제되지 않습니다.'
        : '보관함에서만 빠지며, 기기·폴더의 원본 파일은 삭제되지 않습니다.',
    })
  }

  function confirmRemoveFromLibrary() {
    if (!deleteConfirm) return
    const { ids } = deleteConfirm
    store.removePhotos(ids)
    setTraySelected((prev) => prev.filter((id) => !ids.includes(id)))
    setTrayPreviewId((current) => (current && ids.includes(current) ? undefined : current))
    setDeleteConfirm(null)
  }

  async function exportPdf() {
    const owned: string[] = []
    try {
      const { pages } = useBookStore.getState()
      if (!pages.length) {
        window.alert('내보낼 페이지가 없습니다. 사진을 가져온 뒤 다시 시도해주세요.')
        return
      }
      setExportLabel('원본 준비 중')
      const withFiles = await attachPhotoBinaries(useBookStore.getState().photos)
      const prepared = await preparePrintUrls(withFiles, setExportLabel)
      owned.push(...prepared.owned)
      if (prepared.failed.length) {
        const sample = prepared.failed.slice(0, 5).map((item) => `· ${item.name} (${item.reason})`).join('\n')
        const extra = prepared.failed.length > 5 ? `\n외 ${prepared.failed.length - 5}장` : ''
        const proceed = window.confirm(
          `${prepared.failed.length}장 원본을 준비하지 못했습니다.\n${sample}${extra}\n\n가능한 페이지만 PDF로 만들까요?`,
        )
        if (!proceed) return
      }
      flushSync(() => {
        setPrintUrls(Object.fromEntries(prepared.urls))
        setExportLabel('PDF 만드는 중')
      })
      await waitForExportImages()
      await new Promise((resolve) => window.setTimeout(resolve, 120))
      const { bookSize, orientation } = useBookStore.getState()
      const { pageErrors } = await exportBookPdf(
        bookSize,
        orientation,
        pages.length,
        (page) => setExportLabel(`${page}/${pages.length}`),
      )
      if (pageErrors.length) {
        window.alert(
          `PDF를 저장했지만 ${pageErrors.length}페이지 캡처에 실패했습니다.\n${pageErrors.slice(0, 10).join('\n')}`,
        )
      }
    } catch (error) {
      console.warn('PDF 내보내기에 실패했습니다.', error)
      const message = error instanceof Error
        ? error.message
        : '페이지 캡처에 실패했습니다. 사진이 모두 로드됐는지 확인한 뒤 다시 시도해주세요.'
      window.alert(message)
    } finally {
      revokePrintUrls(owned)
      setPrintUrls({})
      setExportLabel('')
    }
  }

  async function pickFolder() {
    try {
      setProgress({ current: 0, total: 0, label: '폴더를 살펴보는 중' })
      const files = await chooseDirectoryFiles((count) => {
        setProgress({ current: count, total: 0, label: `폴더를 살펴보는 중 · ${count}개` })
      })
      await startNewBook(files)
    } catch (error) {
      setProgress(undefined)
      if (error instanceof Error && error.message === 'FALLBACK_INPUT') inputRef.current?.click()
      else if (error instanceof DOMException && error.name === 'AbortError') return
      else if (error instanceof Error && error.message.includes('촬영한 사진')) setImportError(error.message)
      else setImportError('폴더를 열지 못했습니다. 아래 파일 선택을 사용해주세요.')
    }
  }

  async function createSmartLayout() {
    const targets = store.photos.filter((photo) => photo.analysis?.detailed !== true)
    for (let index = 0; index < targets.length; index += 1) {
      setAnalysisProgress(Math.round(((index + 0.2) / targets.length) * 100))
      try {
        const thumbnail = await fetch(targets[index].thumbUrl).then((response) => response.blob())
        const analysis = await analyzePhoto(thumbnail)
        store.setPhotoAnalysis(targets[index].id, analysis)
      } catch (error) {
        console.warn(`${targets[index].name} 재분석 실패`, error)
      }
    }
    setAnalysisProgress(0)
    store.regenerateLayouts()
  }

  function openCrop(photo: Photo, zoom?: number) {
    const base = photo.crop ?? {
      zoom: 1,
      x: photo.analysis?.focalPoint.x ?? 0.5,
      y: photo.analysis?.focalPoint.y ?? 0.5,
    }
    store.setPhotoCrop(photo.id, { ...base, zoom: zoom ?? base.zoom })
    setSelectedCanvasPhotoId(photo.id)
    setCropPhotoId(photo.id)
  }

  useEffect(() => {
    setCropPhotoId(undefined)
    setSelectedCanvasPhotoId(undefined)
  }, [selectedPage?.id])

  useEffect(() => {
    if (!cropPhotoId && !selectedCanvasPhotoId) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement
      if (target.closest('.inline-crop-controls, .photo-actions, .swap-photo, .resize-handle, .chapter-toolbar, .page-sticker, .page-map-widget, .sticker-picker, .cover-sticker')) return
      const cell = target.closest<HTMLElement>('.canvas-area .photo-cell')
      if (cell) {
        if (event.detail >= 2) return
        const id = cell.dataset.photoId
        if (id && id === cropPhotoId) return
        setCropPhotoId(undefined)
        if (id) setSelectedCanvasPhotoId(id)
        return
      }
      setCropPhotoId(undefined)
      setSelectedCanvasPhotoId(undefined)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [cropPhotoId, selectedCanvasPhotoId])

  useEffect(() => {
    const node = canvasRef.current
    if (!node || !selectedCanvasPhotoId || drawMode) return
    const onWheel = (event: WheelEvent) => {
      if ((event.target as HTMLElement).closest('input, textarea')) return
      const cell = (event.target as HTMLElement).closest<HTMLElement>('.photo-cell')
      if (cell?.dataset.photoId && cell.dataset.photoId !== selectedCanvasPhotoId) return
      const photo = useBookStore.getState().photos.find((item) => item.id === selectedCanvasPhotoId)
      if (!photo) return
      event.preventDefault()
      const base = photo.crop ?? {
        zoom: 1,
        x: photo.analysis?.focalPoint.x ?? 0.5,
        y: photo.analysis?.focalPoint.y ?? 0.5,
      }
      const zoom = Math.max(1, Math.min(2.5, base.zoom * Math.exp(-event.deltaY * 0.002)))
      openCrop(photo, zoom)
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [selectedCanvasPhotoId, drawMode])

  if (restoring) {
    return <main className="welcome loading-screen"><div className="brand"><BookOpen /><span>Year in Frames</span></div><p>지난 작업을 불러오는 중…</p></main>
  }

  if (showWelcome || !store.photos.length) {
    return (
      <main className="welcome">
        <nav className="brand welcome-brand">
          <span className="brand-mark"><BookOpen /><span>Year in Frames</span></span>
          {user && (
            <span className="auth-user-chip">
              <small title={user.email ?? undefined}>{user.email}</small>
              <button type="button" className="text-button" onClick={() => void signOutUser()}>로그아웃</button>
            </span>
          )}
        </nav>
        <section className="welcome-content">
          <span className="eyebrow"><Sparkles size={14} /> 나만의 한 해</span>
          <h1>사진은 그대로.<br /><em>추억은 한 권으로.</em></h1>
          <p className="lead">아이폰 사진 폴더를 선택하면 새 포토북이 만들어집니다.<br />이미 만든 책은 아래에서 이어서 편집할 수 있어요.</p>
          <div className="import-card">
            <button className="import-button" onClick={() => void pickFolder()} disabled={Boolean(progress) || Boolean(shelfBusyId)}>
              <FolderOpen /> 새 포토북 만들기
            </button>
            <button className="text-button" onClick={() => inputRef.current?.click()} disabled={Boolean(progress) || Boolean(shelfBusyId)}>
              파일 또는 폴더로 새 포토북 만들기
            </button>
            <button
              type="button"
              className="text-button"
              disabled={Boolean(progress) || Boolean(shelfBusyId)}
              onClick={() => backupInputRef.current?.click()}
            >
              <Archive size={14} /> 백업에서 복원
            </button>
            <input
              ref={inputRef}
              className="hidden-input"
              type="file"
              multiple
              accept="image/*,.heic,.heif,.mov,video/quicktime"
              {...({ webkitdirectory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                event.target.value = ''
                void startNewBook(files)
              }}
            />
            <input
              ref={backupInputRef}
              className="hidden-input"
              type="file"
              accept=".zip,application/zip"
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void restoreBookBackup(file)
              }}
            />
            {(progress || shelfStatus) && (
              <div className="progress">
                <div><span style={{ width: `${progress && progress.total > 0 ? (progress.current / progress.total) * 100 : 100}%` }} /></div>
                <small>
                  {progress
                    ? (progress.total > 0 ? `${progress.label} · ${progress.current}/${progress.total}` : progress.label)
                    : shelfStatus}
                </small>
              </div>
            )}
            {importError && <p className="error">{importError}</p>}
            {importSkips.length > 0 && (
              <details className="skip-report">
                <summary>건너뛴 파일 {importSkips.length}개</summary>
                <ul>
                  {importSkips.slice(0, 40).map((skip, index) => (
                    <li key={`${skip.name}-${index}`}>
                      <span>{skip.name}</span>
                      <small>{skip.reason}</small>
                    </li>
                  ))}
                  {importSkips.length > 40 && <li><small>외 {importSkips.length - 40}개</small></li>}
                </ul>
              </details>
            )}
          </div>
          {bookList.length > 0 && (
            <section className="book-shelf" aria-label="포토북 목록">
              <header className="book-shelf-heading">
                <h2>내 포토북</h2>
                <span>{bookList.length}권</span>
              </header>
              <ul className="book-shelf-list">
                {bookList.map((book) => {
                  const busy = openingBookId === book.id || deletingBookId === book.id || shelfBusyId === book.id
                  return (
                    <li key={book.id} className="book-card">
                      <button
                        type="button"
                        className="book-card-main"
                        disabled={busy || Boolean(progress) || Boolean(shelfBusyId)}
                        onClick={() => void openBook(book.id)}
                      >
                        <span className="book-card-cover">
                          {book.coverThumbUrl
                            ? <img src={book.coverThumbUrl} alt="" />
                            : <BookOpen />}
                        </span>
                        <span className="book-card-meta">
                          <strong>{book.title || book.periodLabel}</strong>
                          <small>{book.photoCount}장</small>
                          <small>{new Date(book.updatedAt).toLocaleDateString('ko-KR')}</small>
                          {openingBookId === book.id && <em>여는 중…</em>}
                          {shelfBusyId === book.id && shelfStatus && <em>{shelfStatus}</em>}
                        </span>
                      </button>
                      <div className="book-card-actions">
                        <button type="button" title="이름 변경" aria-label="이름 변경" disabled={busy || Boolean(progress) || Boolean(shelfBusyId)} onClick={() => void renameBookOnShelf(book)}>
                          <Pencil />
                        </button>
                        <button type="button" title="백업" aria-label="백업" disabled={busy || Boolean(progress) || Boolean(shelfBusyId)} onClick={() => void backupBookOnShelf(book.id)}>
                          <Archive />
                        </button>
                        <button type="button" title="복제" aria-label="복제" disabled={busy || Boolean(progress) || Boolean(shelfBusyId)} onClick={() => void duplicateBookOnShelf(book.id)}>
                          <Copy />
                        </button>
                        <button
                          type="button"
                          title="삭제"
                          aria-label={`${book.title} 삭제`}
                          disabled={busy || Boolean(progress) || Boolean(shelfBusyId)}
                          onClick={() => {
                            if (window.confirm(`「${book.title || book.periodLabel}」포토북을 삭제할까요?\n사진 원본 파일은 기기에 그대로 남습니다.`)) {
                              void removeBookFromList(book.id)
                            }
                          }}
                        >
                          <Trash2 />
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
          <InvitesPanel />
          <aside className="iphone-tip">
            <strong>아이폰 연결 전 확인</strong>
            설정 → 사진 → Mac 또는 PC로 전송에서 <b>원본 유지</b>를 선택하면 실시간 사진도 가져올 수 있어요.
          </aside>
        </section>
      </main>
    )
  }

  return (
    <div
      className="app-shell"
      style={{ '--tray-width': `${trayWidth}px`, '--tray-thumb': `${thumbSize}px` } as React.CSSProperties}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        if (event.dataTransfer.files.length) void importFiles(Array.from(event.dataTransfer.files), false)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          if (deleteConfirm) {
            setDeleteConfirm(null)
            return
          }
          if (trayPreviewId) {
            setTrayPreviewId(undefined)
            return
          }
          if (traySelected.length) {
            selectTrayPhotos([])
            return
          }
        }
        if ((event.key === 'Delete' || event.key === 'Backspace')
          && document.activeElement?.tagName !== 'INPUT'
          && document.activeElement?.tagName !== 'TEXTAREA'
          && !trayPreviewId) {
          if (traySelected.length) {
            event.preventDefault()
            removeFromLibrary(traySelected)
            return
          }
          const focused = document.querySelector<HTMLElement>('.photo-cell:focus')
          if (focused?.dataset.photoId) store.unplacePhoto(focused.dataset.photoId)
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') store.undo()
      }}
    >
      <div className="app-chrome">
        <header className="topbar">
          <div className="brand"><BookOpen /><span>Year in Frames</span><i title={bookPeriod}>{bookPeriod || bookYear}</i></div>
          <button className="top-add-photo" onClick={() => addInputRef.current?.click()}><ImagePlus /> 사진 추가</button>
          <input ref={addInputRef} className="hidden-input" type="file" multiple accept="image/*,.heic,.heif" onChange={(e) => void importFiles(Array.from(e.target.files ?? []), false)} />
          <div className="top-actions">
            {user?.email && <span className="auth-user-label" title={user.email}>{user.email}</span>}
            <button className="ghost-button" onClick={() => void signOutUser()} title="로그아웃"><LogOut /> 로그아웃</button>
            <button className="ghost-button" onClick={() => void goHome()}><Home /> 첫 화면</button>
            <button className="ghost-button" onClick={store.undo}><RotateCcw /> 되돌리기</button>
            <button className="smart-layout-button" onClick={() => void createSmartLayout()} disabled={Boolean(analysisProgress)}>
              <WandSparkles /> {analysisProgress ? `사진 분석 ${analysisProgress}%` : '스마트 배치'}
            </button>
            <button className="ghost-button" onClick={() => setSettingsOpen(true)}><Settings2 /> 책 설정</button>
            <button
              className="primary-button"
              onClick={() => void exportPdf()}
              disabled={Boolean(exportLabel)}
            >
              <Download /> {exportLabel || 'PDF 내보내기'}
            </button>
          </div>
        </header>
        {(importError || importSkips.length > 0 || progress) && (
          <div className="import-banner" role="status">
            {progress && (
              <span>{progress.total > 0 ? `${progress.label} · ${progress.current}/${progress.total}` : progress.label}</span>
            )}
            {!progress && importError && <span>{importError}</span>}
            {importSkips.length > 0 && (
              <details className="skip-report inline">
                <summary>건너뛴 파일 {importSkips.length}개</summary>
                <ul>
                  {importSkips.slice(0, 20).map((skip, index) => (
                    <li key={`${skip.name}-${index}`}>
                      <span>{skip.name}</span>
                      <small>{skip.reason}</small>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <button type="button" className="text-button" onClick={() => { setImportError(''); setImportSkips([]) }}>닫기</button>
          </div>
        )}
      </div>

      <aside className="page-sidebar">
        <div className="sidebar-heading">
          <button type="button" className={`side-tab${sidePanel === 'pages' ? ' active' : ''}`} onClick={() => setSidePanel('pages')}>페이지</button>
          <button type="button" className={`side-tab${sidePanel === 'memories' ? ' active' : ''}`} onClick={() => setSidePanel('memories')}>추억</button>
          {sidePanel === 'pages' && <button onClick={() => store.pages[0] && store.selectPage(store.pages[0].id)} title="포토북 첫 페이지로 이동"><ChevronsLeft /> 처음</button>}
          <b>{store.pages.length} / {MAX_PAGES}</b>
        </div>
        {sidePanel === 'memories' ? <MemoriesPanel /> : (
        <>
        <div className="analysis-summary">
          <span><Users /> 인물 {store.photos.filter((photo) => photo.analysis?.scene === 'people').length}</span>
          <span><Mountain /> 풍경 {store.photos.filter((photo) => photo.analysis?.scene === 'landscape').length}</span>
        </div>
        {store.pages.length >= MAX_PAGES && <div className="page-warning">50페이지 한도입니다. 사진 크기를 작게 바꿔 페이지를 줄여보세요.</div>}
        <div className="page-list" ref={pageListRef}>
          <button className={`page-thumb cover-thumb ${coverMode ? 'active' : ''}`} onClick={() => setCoverMode(true)}>
            <span className="page-thumb-label">표지</span>
            <MiniJacket year={bookYear} />
          </button>
          {store.pages.map((page, index) => {
            const chapter = store.chapters.find((item) => item.id === page.chapterId)
            const heading = store.pages[index - 1]?.chapterId === page.chapterId ? undefined : chapterHeading(chapter, store.photos)
            const caption = pageCaption(chapter, store.pageNotes[page.id] ?? [], store.photos)
            const completed = Boolean(store.completedPages[page.id])
            const canInsert = store.pages.length < MAX_PAGES && page.chapterId !== YEAR_CHAPTER_ID
            return (
              <div key={page.id} className="page-list-block">
                {heading && chapter && (
                  <label className="page-chapter">
                    <small>{heading.label}</small>
                    <input
                      aria-label="챕터 이름"
                      value={chapter.title}
                      placeholder="챕터 이름"
                      onChange={(event) => store.updateChapter(chapter.id, { title: event.target.value })}
                    />
                  </label>
                )}
                <div className={`page-thumb-wrap${completed ? ' is-complete' : ''}`}>
                <button
                  className={`page-thumb ${!coverMode && page.id === selectedPage?.id ? 'active' : ''}${completed ? ' is-complete' : ''}`}
                  onClick={() => { setCoverMode(false); store.selectPage(page.id) }}
                  onDragOver={(event) => {
                    if (completed) return
                    event.preventDefault()
                  }}
                  onDrop={(event) => {
                    if (completed) return
                    for (const photoId of readDroppedPhotoIds(event)) {
                      if (page.type === 'photos') store.addPhotoToPage(photoId, page.id)
                      else store.movePhoto(photoId, page.id)
                    }
                  }}
                >
                  <span className="page-thumb-label">{index + 1}</span>
                  <MiniPage page={page} chapter={chapter} notes={store.pageNotes[page.id] ?? []} />
                  {caption && <em className="page-thumb-caption">{caption}</em>}
                </button>
                {!completed && (
                  <button type="button" className="page-delete" aria-label="페이지 삭제" title="이 페이지를 책에서 빼기" onClick={() => store.removePage(page.id)}><Trash2 /></button>
                )}
                </div>
                {canInsert && (
                  <button
                    type="button"
                    className="page-insert"
                    title="아래에 빈 페이지 추가"
                    aria-label="아래에 빈 페이지 추가"
                    onClick={() => {
                      setCoverMode(false)
                      store.addBlankPage(page.id)
                    }}
                  >
                    <Plus />
                  </button>
                )}
              </div>
            )
          })}
          <button
            type="button"
            className="page-add-button"
            disabled={store.pages.length >= MAX_PAGES || !store.chapters.some((chapter) => chapter.id !== YEAR_CHAPTER_ID)}
            onClick={() => {
              setCoverMode(false)
              store.addBlankPage(selectedPage?.chapterId === YEAR_CHAPTER_ID ? undefined : selectedPage?.id)
            }}
          >
            <Plus /> 페이지 추가
          </button>
        </div>
        </>
        )}
      </aside>

      <main className="workspace">
        {(coverMode || selectedPage) && (
          <>
            <div className="chapter-toolbar">
              {coverMode ? (
                <CoverBar
                  stickerPanel={stickerPicker && stickerPicker !== 'page' ? stickerPicker : null}
                  onStickerPanel={(panel) => { setStickerPicker(panel); setDecorOpen(false) }}
                  decorOpen={decorOpen}
                  onDecorOpen={(open) => { setDecorOpen(open); if (open) setStickerPicker(null) }}
                />
              ) : (
                <>
                  <div>
                    <span>{selectedChapter ? chapterHeading(selectedChapter, store.photos).label : '챕터'}</span>
                    <input
                      value={selectedChapter?.title ?? ''}
                      aria-label="챕터 제목"
                      placeholder="챕터 이름"
                      onChange={(event) => selectedChapter && store.updateChapter(selectedChapter.id, { title: event.target.value })}
                    />
                  </div>
                  {!pageCompleted && (
                    <div className="note-toolbar">
                      <button type="button" onClick={() => store.addPageNote(selectedPage.id)}>메모</button>
                      <button type="button" className={drawMode ? 'active' : ''} onClick={() => { setDrawMode((on) => !on); setStickerPicker(null); setDecorOpen(false) }}><Pencil /> 그리기</button>
                      <button
                        type="button"
                        className={stickerPicker === 'page' ? 'active' : ''}
                        onClick={() => { setStickerPicker((open) => (open === 'page' ? null : 'page')); setDrawMode(false); setDecorOpen(false) }}
                      >
                        스티커
                      </button>
                      <button
                        type="button"
                        className={decorOpen ? 'active' : ''}
                        onClick={() => { setDecorOpen((open) => !open); setDrawMode(false); setStickerPicker(null) }}
                      >
                        테두리
                      </button>
                      <button
                        type="button"
                        className={store.pageMaps[selectedPage.id] ? 'active' : ''}
                        onClick={() => {
                          if (store.pageMaps[selectedPage.id]) store.removePageMap(selectedPage.id)
                          else store.addPageMap(selectedPage.id)
                        }}
                      >
                        지도
                      </button>
                    </div>
                  )}
                  {!pageCompleted && drawMode && (
                    <div className="draw-tools">
                      <label className="note-swatch">색<input type="color" aria-label="펜 색" value={penColor} onChange={(event) => setPenColor(event.target.value)} /></label>
                      <label className="note-opacity">굵기<input type="range" min={0.4} max={2.4} step={0.1} aria-label="펜 굵기" value={penSize} onChange={(event) => setPenSize(Number(event.target.value))} /></label>
                      <button type="button" onClick={() => store.undoStroke(selectedPage.id)}>한 획 취소</button>
                      <button type="button" onClick={() => store.clearStrokes(selectedPage.id)}>모두 지우기</button>
                    </div>
                  )}
                  {!pageCompleted && stickerPicker === 'page' && selectedPage && (
                    <StickerPicker
                      onPick={(emoji) => {
                        store.addPageSticker(selectedPage.id, emoji)
                        setStickerPicker(null)
                      }}
                      onClose={() => setStickerPicker(null)}
                    />
                  )}
                  {!pageCompleted && decorOpen && (
                    <PageDecorPicker
                      frame={store.pageFrame}
                      onChange={(next) => useBookStore.getState().setPageFrame(next)}
                      onClose={() => setDecorOpen(false)}
                    />
                  )}
                  <span>페이지 {selectedIndex + 1}</span>
                  <button
                    type="button"
                    className={`page-complete-button${pageCompleted ? ' is-complete' : ''}`}
                    onClick={() => {
                      if (!selectedPage) return
                      if (!pageCompleted) {
                        setDrawMode(false)
                        setStickerPicker(null)
                        setCropPhotoId(undefined)
                        setSelectedCanvasPhotoId(undefined)
                      }
                      store.setPageCompleted(selectedPage.id, !pageCompleted)
                    }}
                  >
                    {pageCompleted ? <><Lock size={14} /> 완료 취소</> : <><Check size={14} /> 완료</>}
                  </button>
                  {!pageCompleted && (
                    <button type="button" onClick={() => selectedPage && store.removePage(selectedPage.id)}>페이지 삭제</button>
                  )}
                </>
              )}
            </div>
            <div className="canvas-area" ref={canvasRef}>
              {!coverMode && <button className="page-arrow" disabled={selectedIndex === 0} onClick={() => store.selectPage(store.pages[selectedIndex - 1].id)}><ChevronLeft /></button>}
              {coverMode ? <BookJacket year={bookYear} editable /> : (
                <PagePaper
                  page={selectedPage}
                  chapter={selectedChapter}
                  editable={!pageCompleted}
                  drawing={!pageCompleted && drawMode}
                  penColor={penColor}
                  penSize={penSize}
                  onOpenLive={pageCompleted ? undefined : ((photo) => { void attachPhotoBinary(photo).then(setLivePhoto) })}
                  croppingPhotoId={pageCompleted ? undefined : cropPhotoId}
                  selectedPhotoId={pageCompleted ? undefined : selectedCanvasPhotoId}
                  onSelectPhoto={pageCompleted ? undefined : setSelectedCanvasPhotoId}
                  onCrop={pageCompleted ? undefined : openCrop}
                  onCloseCrop={() => setCropPhotoId(undefined)}
                  pageNumber={selectedIndex + 1}
                  placeRevision={placeRevision}
                />
              )}
              {!coverMode && <button className="page-arrow" disabled={selectedIndex === store.pages.length - 1} onClick={() => store.selectPage(store.pages[selectedIndex + 1].id)}><ChevronRight /></button>}
            </div>
            <div className="drag-hint">
              {coverMode
                ? <><Upload size={15} /> 앞표지 · 책등 · 뒤표지를 수정합니다. 사진은 끌어다 놓거나 위 목록에서 고릅니다.</>
                : pageCompleted
                  ? <><Lock size={15} /> 이 페이지는 완료되어 수정할 수 없습니다. 완료 취소를 누르면 다시 편집할 수 있습니다.</>
                  : drawMode
                    ? <><Pencil size={15} /> 페이지 위를 드래그해 그립니다. 그리기를 다시 누르면 끝납니다.</>
                    : <><Upload size={15} /> 사진을 고른 뒤 다른 사진의 바꾸기를 누르면 두 장만 자리가 바뀝니다</>}
            </div>
          </>
        )}
      </main>

      <aside className="photo-tray">
        <div
          className="tray-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="사진 보관함 폭 조절"
          onPointerDown={(event) => {
            event.preventDefault()
            const handle = event.currentTarget
            const startX = event.clientX
            const startWidth = trayWidth
            handle.setPointerCapture(event.pointerId)
            handle.classList.add('dragging')
            const move = (moveEvent: PointerEvent) => {
              const next = Math.min(
                window.innerWidth - 380,
                Math.max(thumbSize + TRAY_CHROME, startWidth + startX - moveEvent.clientX),
              )
              setTrayWidth(next)
            }
            const end = () => {
              handle.classList.remove('dragging')
              handle.removeEventListener('pointermove', move)
              handle.removeEventListener('pointerup', end)
              setTrayWidth((width) => {
                localStorage.setItem('photobook-tray-width', String(width))
                return width
              })
            }
            handle.addEventListener('pointermove', move)
            handle.addEventListener('pointerup', end)
          }}
        />
        <section className="template-section" style={{ '--template-size': `${templateSize}px` } as React.CSSProperties}>
          <div className="tray-heading">
            <span>추천 배치</span>
            <div className="thumb-size">
              <button
                type="button"
                aria-label="배치 작게"
                disabled={templateSize <= TEMPLATE_SIZES[0]}
                onClick={() => setTemplateSize((size) => {
                  const next = TEMPLATE_SIZES.filter((item) => item < size).at(-1) ?? size
                  localStorage.setItem('photobook-template-size', String(next))
                  return next
                })}
              >
                <Minus />
              </button>
              <button
                type="button"
                aria-label="배치 크게"
                disabled={templateSize >= TEMPLATE_SIZES.at(-1)!}
                onClick={() => setTemplateSize((size) => {
                  const next = TEMPLATE_SIZES.find((item) => item > size) ?? size
                  localStorage.setItem('photobook-template-size', String(next))
                  return next
                })}
              >
                <Plus />
              </button>
            </div>
          </div>
          <div className="aspect-mode">
            <span>나머지 사진</span>
            <div>
              <button
                className={(selectedPage?.flowAspect ?? 'locked') === 'locked' ? 'active' : ''}
                disabled={pageCompleted}
                onClick={() => selectedPage && store.setPageFlowAspect(selectedPage.id, 'locked')}
              >
                비율 유지
              </button>
              <button
                className={selectedPage?.flowAspect === 'free' ? 'active' : ''}
                disabled={pageCompleted}
                onClick={() => selectedPage && store.setPageFlowAspect(selectedPage.id, 'free')}
              >
                자유 채우기
              </button>
            </div>
          </div>
          {pageCompleted ? (
            <p className="tray-empty">완료된 페이지는 배치를 바꿀 수 없습니다.</p>
          ) : selectedPage?.type === 'photos' ? (
            <div className="template-options">
              {availableLayouts(selectedPage.photoIds.length).map((layout) => {
                const pagePhotos = selectedPage.photoIds.map((id) => store.photos.find((photo) => photo.id === id)).filter((photo): photo is Photo => Boolean(photo))
                const previewRatio = store.orientation === 'portrait' ? store.bookSize.widthMm / store.bookSize.heightMm : store.bookSize.heightMm / store.bookSize.widthMm
                return (
                <button
                  key={layout}
                  type="button"
                  className={selectedPage.layoutId === layout ? 'active' : ''}
                  onClick={(event) => {
                    event.stopPropagation()
                    store.setPageLayout(selectedPage.id, layout)
                  }}
                  title={layoutLabel(layout)}
                >
                  <TemplatePreview layout={layout} photos={pagePhotos} ratio={previewRatio} />
                  <span>{layoutLabel(layout)}</span>
                </button>
                )
              })}
            </div>
          ) : <p className="tray-empty">사진 페이지에서 추천 배치를 선택할 수 있어요.</p>}
        </section>
        <section className={`photo-library${trayDragging ? ' is-dragging' : ''}${traySelected.length ? ' has-selection' : ''}`}>
          <div className="tray-heading">
            <span>사진 보관함</span>
            <div className="thumb-size">
              <button
                type="button"
                aria-label="사진 작게"
                disabled={thumbSize <= THUMB_SIZES[0]}
                onClick={() => setThumbSize((size) => {
                  const next = THUMB_SIZES.filter((item) => item < size).at(-1) ?? size
                  localStorage.setItem('photobook-thumb-size', String(next))
                  return next
                })}
              >
                <Minus />
              </button>
              <button
                type="button"
                aria-label="사진 크게"
                disabled={thumbSize >= THUMB_SIZES.at(-1)!}
                onClick={() => setThumbSize((size) => {
                  const next = THUMB_SIZES.find((item) => item > size) ?? size
                  localStorage.setItem('photobook-thumb-size', String(next))
                  return next
                })}
              >
                <Plus />
              </button>
            </div>
            <b>{store.photos.length}</b>
          </div>
          {traySelected.length > 0 && (
            <div className="tray-selection-bar">
              <span>{traySelected.length}장 선택</span>
              <button type="button" onClick={() => selectTrayPhotos([])}>선택 해제</button>
              <button type="button" className="tray-selection-delete" onClick={() => removeFromLibrary(traySelected)}>
                <Trash2 /> 삭제
              </button>
            </div>
          )}
          <div
            className="photo-tray-list"
            ref={trayListRef}
            onPointerDown={beginTrayMarquee}
            onPointerMove={moveTrayMarquee}
            onPointerUp={endTrayMarquee}
            onPointerCancel={endTrayMarquee}
          >
            <div ref={marqueeBoxRef} className="tray-marquee" hidden />
            {trayEntries.map((entry) => {
              if (entry.type === 'month') return <div key={entry.key} className="tray-month">{entry.label}</div>
              if (entry.type === 'day') return <div key={entry.key} className="tray-day">{entry.label}</div>
              const photo = entry.photo
              const placement = pagePlacements.get(photo.id)
              const onCanvas = onCanvasIds.has(photo.id)
              const selected = traySelectedSet.has(photo.id)
              return (
                <div key={photo.id} className={`tray-photo-wrap${selected ? ' is-selected' : ''}`} data-photo-id={photo.id}>
                  <button
                    className={`tray-photo${placement ? ' placed' : ''}${onCanvas ? ' on-canvas' : ''}${selected ? ' is-selected' : ''}`}
                    data-photo-id={photo.id}
                    draggable
                    onDragStart={(event) => {
                      const ids = selected ? traySelected : [photo.id]
                      if (!selected) selectTrayPhotos([photo.id], photo.id)
                      event.dataTransfer.setData('photo/id', ids[0])
                      event.dataTransfer.setData('photo/ids', JSON.stringify(ids))
                      event.dataTransfer.effectAllowed = 'move'
                      setTrayDragging(true)
                    }}
                    onDragEnd={() => {
                      setTrayDragging(false)
                      setTrashHot(false)
                    }}
                    onClick={(event) => toggleTrayPhoto(photo.id, event)}
                    onDoubleClick={() => openCrop(photo)}
                    title={[
                      photo.name,
                      photoHoldLabel(photo.excludeReason, photo.holdReason),
                      'Ctrl/⌘ 클릭·드래그로 다중 선택',
                      placement ? `${placement.number}페이지로 이동` : '페이지로 드래그',
                    ].filter(Boolean).join(' · ')}
                  >
                    <img src={photo.thumbUrl} alt={photo.name} loading="lazy" decoding="async" style={photoStyle(photo)} />
                    {placement && <b className="page-mark">{placement.number}</b>}
                    {(photo.excludeReason || photo.holdReason) && <em className="exclude-mark">{photoHoldLabel(photo.excludeReason, photo.holdReason)}</em>}
                    {photo.excludeReason && (
                      <span
                        className="include-mark"
                        onClick={(event) => {
                          event.stopPropagation()
                          store.includePhotos([photo.id])
                        }}
                      >
                        넣기
                      </span>
                    )}
                    <span>{sceneLabel(photo.analysis?.scene ?? 'other')}</span>
                  </button>
                  <button
                    type="button"
                    className="tray-zoom"
                    aria-label="사진 크게 보기"
                    title="크게 보기"
                    onClick={(event) => {
                      event.stopPropagation()
                      selectTrayPhotos([photo.id], photo.id)
                      setTrayPreviewId(photo.id)
                    }}
                  >
                    <Maximize2 />
                  </button>
                  <button
                    type="button"
                    className="tray-delete"
                    aria-label="보관함에서 삭제"
                    title="보관함에서 빼기 (기기 원본은 그대로)"
                    onClick={(event) => {
                      event.stopPropagation()
                      removeFromLibrary(selected && traySelectedSet.has(photo.id) ? traySelected : [photo.id])
                    }}
                  >
                    <Trash2 />
                  </button>
                </div>
              )
            })}
          </div>
          <div
            className={`tray-trash${trayDragging ? ' is-visible' : ''}${trashHot ? ' is-hot' : ''}`}
            onDragEnter={(event) => {
              if (!trayDragging) return
              event.preventDefault()
              setTrashHot(true)
            }}
            onDragOver={(event) => {
              if (!trayDragging) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              setTrashHot(true)
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node)) return
              setTrashHot(false)
            }}
            onDrop={(event) => {
              event.preventDefault()
              const ids = readDroppedPhotoIds(event)
              setTrayDragging(false)
              setTrashHot(false)
              if (ids.length) removeFromLibrary(ids)
            }}
          >
            <Trash2 />
            <span>여기에 놓으면 보관함에서 삭제</span>
            <small>기기·폴더의 원본 파일은 삭제되지 않습니다</small>
          </div>
        </section>
      </aside>

      {settingsOpen && (
        <div className="settings-panel">
          <header><h2>책 설정</h2><button className="icon-button" onClick={() => setSettingsOpen(false)}><X /></button></header>
          <label>크기
            <select
              value={BOOK_SIZES.find((size) => size.name === store.bookSize.name)?.name ?? 'custom'}
              onChange={(event) => {
                const size = BOOK_SIZES.find((item) => item.name === event.target.value)
                if (size) store.setBookSize(size)
              }}
            >
              {BOOK_SIZES.map((size) => <option key={size.name} value={size.name}>{size.name} · {size.widthMm}×{size.heightMm}mm</option>)}
              <option value="custom">사용자 지정</option>
            </select>
          </label>
          <div className="field-row">
            <label>너비(mm)<input type="number" value={customSize.widthMm} onChange={(e) => setCustomSize((s) => ({ ...s, widthMm: Number(e.target.value) }))} /></label>
            <label>높이(mm)<input type="number" value={customSize.heightMm} onChange={(e) => setCustomSize((s) => ({ ...s, heightMm: Number(e.target.value) }))} /></label>
          </div>
          <button className="secondary-button" onClick={() => store.setBookSize({ name: '사용자 지정', ...customSize })}>사용자 크기 적용</button>
          <label>방향
            <div className="segmented">
              <button className={store.orientation === 'portrait' ? 'active' : ''} onClick={() => store.setOrientation('portrait')}>세로</button>
              <button className={store.orientation === 'landscape' ? 'active' : ''} onClick={() => store.setOrientation('landscape')}>가로</button>
            </div>
          </label>
          <div className="field-row">
            <label>안쪽 여백<input type="number" min={0} value={store.marginMm} onChange={(e) => store.setPrintOptions(Number(e.target.value), store.bleedMm)} /></label>
            <label>재단 여유<input type="number" min={0} value={store.bleedMm} onChange={(e) => store.setPrintOptions(store.marginMm, Number(e.target.value))} /></label>
          </div>
          <div className="setting-summary"><Maximize2 /><span><b>{store.bookSize.name}</b>{store.bookSize.widthMm} × {store.bookSize.heightMm}mm · 300dpi</span></div>
          <label className="face-toggle">
            <input
              type="checkbox"
              checked={store.curation.faceGroupsEnabled}
              disabled={faceProgress > 0}
              onChange={(event) => void toggleFaceGroups(event.target.checked)}
            />
            얼굴 그룹{faceProgress > 0 ? ` ${faceProgress}%` : ''}
          </label>
          {store.curation.faceGroupsEnabled && (
            <p className="face-hint">
              {(store.curation.focusFaceIds?.length ?? 0) > 0
                ? `선택한 ${store.curation.focusFaceIds!.length}명이 나온 사진만 책에 넣습니다.`
                : '사람을 고르면 그 사람들이 나온 사진만 포토북에 넣습니다.'}
              {(store.curation.focusFaceIds?.length ?? 0) > 0 && (
                <button type="button" className="text-button" onClick={() => store.clearFocusFaces()}>전체 보기</button>
              )}
            </p>
          )}
          {store.curation.faceGroupsEnabled && store.faceGroups.map((group) => {
            const cover = store.photos.find((photo) => photo.id === (group.coverPhotoId ?? group.photoIds[0]))
            const focused = (store.curation.focusFaceIds ?? []).includes(group.id)
            return (
              <div key={group.id} className={`face-row${focused ? ' is-focused' : ''}${group.hidden ? ' is-hidden' : ''}`}>
                {cover && <img src={cover.thumbUrl} alt="" />}
                <input
                  aria-label="사람 이름"
                  value={group.name}
                  placeholder="이름"
                  onChange={(event) => store.renameFaceGroup(group.id, event.target.value)}
                />
                <button
                  type="button"
                  className={focused ? 'active' : ''}
                  disabled={group.hidden}
                  title="이 사람이 나온 사진만 책에 포함"
                  onClick={() => store.toggleFocusFace(group.id)}
                >
                  책
                </button>
                <button type="button" onClick={() => store.setFaceGroupHidden(group.id, !group.hidden)}>{group.hidden ? '표시' : '숨기기'}</button>
              </div>
            )
          })}
        </div>
      )}

      {livePhoto && <LivePhotoPicker photo={livePhoto} onClose={() => setLivePhoto(undefined)} onSelect={(data) => store.setSelectedFrame(livePhoto.id, data)} />}
      {deleteConfirm && (
        <div className="confirm-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-confirm-title" onClick={() => setDeleteConfirm(null)}>
          <div className="confirm-card" onClick={(event) => event.stopPropagation()}>
            <h2 id="delete-confirm-title">{deleteConfirm.title}</h2>
            <p>{deleteConfirm.body}</p>
            <div className="confirm-actions">
              <button type="button" className="ghost-button" onClick={() => setDeleteConfirm(null)}>취소</button>
              <button type="button" className="danger-button" onClick={confirmRemoveFromLibrary}>삭제</button>
            </div>
          </div>
        </div>
      )}
      {trayPreviewId && (
        <TrayPhotoPreview
          photoId={trayPreviewId}
          photoIds={libraryPhotoIds()}
          photos={store.photos}
          placement={pagePlacements.get(trayPreviewId)}
          onClose={() => setTrayPreviewId(undefined)}
          onNavigate={(id) => {
            setTrayPreviewId(id)
            selectTrayPhotos([id], id)
          }}
          onGoToPage={(pageId) => {
            setTrayPreviewId(undefined)
            setCoverMode(false)
            store.selectPage(pageId)
          }}
          onCrop={(photo) => {
            setTrayPreviewId(undefined)
            openCrop(photo)
          }}
        />
      )}
      <div className="export-stage" aria-hidden>
        <BookJacket year={bookYear} printUrls={printUrls} printing />
        {store.pages.map((page, index) => (
          <PagePaper key={page.id} page={page} chapter={store.chapters.find((chapter) => chapter.id === page.chapterId)} exportIndex={index} printUrls={printUrls} pageNumber={index + 1} placeRevision={placeRevision} />
        ))}
      </div>
    </div>
  )
}

function TrayPhotoPreview({
  photoId,
  photoIds,
  photos,
  placement,
  onClose,
  onNavigate,
  onGoToPage,
  onCrop,
}: {
  photoId: string
  photoIds: string[]
  photos: Photo[]
  placement?: { pageId: string; number: number }
  onClose: () => void
  onNavigate: (id: string) => void
  onGoToPage: (pageId: string) => void
  onCrop: (photo: Photo) => void
}) {
  const index = Math.max(0, photoIds.indexOf(photoId))
  const photo = photos.find((item) => item.id === photoId)
  const thumbSrc = photo?.thumbUrl
  const fullSrc = photo?.selectedFrame || (photo && photo.url !== photo.thumbUrl ? photo.url : undefined) || thumbSrc
  const [src, setSrc] = useState(thumbSrc || fullSrc)
  const captured = photo?.capturedAt
    ? new Date(photo.capturedAt).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })
    : ''

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' && index > 0) onNavigate(photoIds[index - 1])
      if (event.key === 'ArrowRight' && index < photoIds.length - 1) onNavigate(photoIds[index + 1])
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, photoIds, onClose, onNavigate])

  useEffect(() => {
    if (!thumbSrc && !fullSrc) return
    setSrc(thumbSrc || fullSrc)
    if (!fullSrc || fullSrc === thumbSrc) return
    let cancelled = false
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => {
      if (!cancelled) setSrc(fullSrc)
    }
    img.src = fullSrc
    return () => {
      cancelled = true
      img.onload = null
    }
  }, [photoId, thumbSrc, fullSrc])

  if (!photo || !src) return null

  const rotation = ((photo.rotation ?? 0) % 360 + 360) % 360
  const previewStyle: React.CSSProperties = {
    objectFit: 'contain',
    transform: rotation ? `rotate(${rotation}deg)` : undefined,
  }

  return (
    <div className="tray-preview-backdrop" role="dialog" aria-modal="true" aria-label="사진 미리보기" onClick={onClose}>
      <div className="tray-preview" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2>{photo.name}</h2>
            {captured && <p>{captured}</p>}
          </div>
          <button type="button" className="icon-button" aria-label="닫기" onClick={onClose}><X /></button>
        </header>
        <div className="tray-preview-stage">
          <button
            type="button"
            className="tray-preview-nav"
            aria-label="이전 사진"
            disabled={index <= 0}
            onClick={() => onNavigate(photoIds[index - 1])}
          >
            <ChevronLeft />
          </button>
          <img src={src} alt={photo.name} style={previewStyle} />
          <button
            type="button"
            className="tray-preview-nav"
            aria-label="다음 사진"
            disabled={index >= photoIds.length - 1}
            onClick={() => onNavigate(photoIds[index + 1])}
          >
            <ChevronRight />
          </button>
        </div>
        <footer>
          <span>{index + 1} / {photoIds.length}</span>
          <div className="tray-preview-actions">
            {placement && (
              <button type="button" className="ghost-button" onClick={() => onGoToPage(placement.pageId)}>
                {placement.number}페이지로 이동
              </button>
            )}
            <button type="button" className="ghost-button" onClick={() => onCrop(photo)}><Crop /> 자르기</button>
            <button type="button" className="primary-button" onClick={onClose}>닫기</button>
          </div>
        </footer>
      </div>
    </div>
  )
}

function MiniPage({ page, chapter, notes = [] }: { page: BookPage; chapter?: Chapter; notes?: PageNote[] }) {
  const { photos, bookSize, orientation, pageStickers } = useBookStore(useShallow((state) => ({
    photos: state.photos,
    bookSize: state.bookSize,
    orientation: state.orientation,
    pageStickers: state.pageStickers,
  })))
  const items = page.photoIds.map((id) => photos.find((photo) => photo.id === id)).filter(Boolean) as Photo[]
  const ratio = orientation === 'portrait' ? bookSize.widthMm / bookSize.heightMm : bookSize.heightMm / bookSize.widthMm
  const preserveFlowAspect = (page.flowAspect ?? 'locked') === 'locked'
  const rects = page.layoutId === 'adaptive-flow' ? computeAdaptiveLayout(items, ratio, preserveFlowAspect) : []
  const activeAnchorId = [...items]
    .filter((photo) => photo.freeFrame)
    .sort((a, b) => (b.framePriority ?? 0) - (a.framePriority ?? 0))[0]?.id
  const chapterYearNum = chapterYearLabel(chapter, photos) ?? (Number(items[0]?.capturedAt.slice(0, 4)) || CURRENT_YEAR)
  const monthLabel = chapter?.type === 'trip'
    ? '여행'
    : chapter?.month
      ? `${chapterYearNum}년 ${chapter.month}월`
      : ''
  const chapterYear = String(chapterYearNum)
  const memos = notes.filter((note) => note.kind === 'memo')
  const stickers = pageStickers[page.id] ?? []

  if (page.type === 'year-months') {
    return (
      <div className="mini-paper type-year-months" style={{ '--page-ratio': ratio } as React.CSSProperties}>
        <strong className="mini-year-label">MONTHS</strong>
        <div className="mini-year-grid">
          {items.slice(0, 12).map((photo) => (
            <span key={photo.id}>
              <img src={photo.thumbUrl || photo.url} alt="" style={photoStyle(photo)} />
            </span>
          ))}
        </div>
      </div>
    )
  }
  if (page.type === 'year-map') {
    return (
      <div className="mini-paper type-year-map" style={{ '--page-ratio': ratio } as React.CSSProperties}>
        <MapPinned />
        <strong className="mini-year-label">MAP</strong>
        <div className="mini-year-grid is-map">
          {items.slice(0, 9).map((photo) => (
            <span key={photo.id}>
              <img src={photo.thumbUrl || photo.url} alt="" style={photoStyle(photo)} />
            </span>
          ))}
        </div>
      </div>
    )
  }
  if (page.type === 'intro') {
    const cover = items[0]
    return (
      <div className="mini-paper type-intro" style={{ '--page-ratio': ratio } as React.CSSProperties}>
        {cover && <img className="mini-cover-image" src={cover.thumbUrl || cover.url} alt="" style={photoStyle(cover)} />}
        <div className="mini-cover-shade" />
        <div className="mini-copy">
          <span>{chapter?.type === 'trip' ? 'JOURNEY' : `${chapter?.month?.toString().padStart(2, '0') ?? ''} / ${chapterYear}`}</span>
          <b>{chapter?.title}</b>
          {chapter?.note && <em>{chapter.note}</em>}
        </div>
        {stickers.map((sticker) => (
          <span
            key={sticker.id}
            className="mini-sticker"
            style={{
              left: `${sticker.x * 100}%`,
              top: `${sticker.y * 100}%`,
              width: `${sticker.size * 100}%`,
              transform: `translate(-50%, -50%) rotate(${sticker.rotation ?? 0}deg)`,
            }}
            aria-hidden
          >
            {sticker.emoji}
          </span>
        ))}
        {memos.map((note) => (
          <span
            key={note.id}
            className={`mini-note kind-memo color-${note.color}`}
            style={{
              left: `${note.x * 100}%`,
              top: `${note.y * 100}%`,
              width: `${(note.width ?? 0.3) * 100}%`,
              height: `${(note.height ?? 0.24) * 100}%`,
              color: noteLook(note).text,
              backgroundColor: noteLook(note).css,
            }}
          >
            {note.text}
          </span>
        ))}
      </div>
    )
  }

  return (
    <div className={`mini-paper type-${page.type} layout-${page.layoutId ?? ''}${items.length ? '' : ' is-empty'}`} style={{ '--page-ratio': ratio } as React.CSSProperties}>
      {!items.length && <span className="mini-empty">빈 페이지</span>}
      {items.slice(0, 8).map((photo, index) => (
        <span
          className={`mini-cell ${activeAnchorId === photo.id ? 'free-anchor' : ''} ${photo.layoutLocked ? 'is-locked' : ''}`}
          key={photo.id}
          style={page.layoutId === 'adaptive-flow' ? adaptiveMiniStyle(rects[index], activeAnchorId === photo.id) : undefined}
        >
          <img src={photo.thumbUrl} alt="" style={photoStyle(photo, rects[index], ratio, preserveFlowAspect)} />
        </span>
      ))}
      {page.type === 'map' && <MapPinned />}
      {monthLabel && <span className="mini-month">{monthLabel}</span>}
      {memos.map((note) => (
        <span
          key={note.id}
          className={`mini-note kind-memo color-${note.color}`}
          style={{
            left: `${note.x * 100}%`,
            top: `${note.y * 100}%`,
            width: `${(note.width ?? 0.3) * 100}%`,
            height: `${(note.height ?? 0.24) * 100}%`,
            color: noteLook(note).text,
            backgroundColor: noteLook(note).css,
          }}
        >
          {note.text}
        </span>
      ))}
    </div>
  )
}

function chapterYearLabel(chapter: Chapter | undefined, photos: Photo[]) {
  if (!chapter?.photoIds?.length) return undefined
  for (const id of chapter.photoIds) {
    const photo = photos.find((item) => item.id === id)
    if (!photo) continue
    const year = new Date(photo.capturedAt).getFullYear()
    if (!Number.isNaN(year)) return year
  }
  return undefined
}

function pageCaption(chapter: Chapter | undefined, notes: PageNote[], photos: Photo[] = []) {
  const year = chapterYearLabel(chapter, photos)
  const month = chapter?.type === 'trip'
    ? (chapter.title || '여행')
    : chapter?.month
      ? (year ? `${year}년 ${chapter.month}월` : `${chapter.month}월`)
      : ''
  const title = chapter?.type === 'month' && chapter.title && chapter.title !== `${chapter.month}월` ? chapter.title : ''
  const phrases = notes.map((note) => note.text.trim()).filter(Boolean)
  return [month, title, chapter?.note, ...phrases].filter(Boolean).join(' · ')
}

function chapterHeading(chapter?: Chapter, photos: Photo[] = []) {
  if (!chapter) return { label: '챕터', title: '' }
  if (chapter.id === YEAR_CHAPTER_ID) {
    const year = chapterYearLabel(chapter, photos) ?? bookYearFromPhotos(photos)
    return { label: `${year}년 기록`, title: chapter.title === '한 해의 기록' ? '' : chapter.title }
  }
  const year = chapterYearLabel(chapter, photos)
  const label = chapter.type === 'trip'
    ? '여행 챕터'
    : year
      ? `${year}년 ${chapter.month}월 챕터`
      : `${chapter.month}월 챕터`
  const sameAsLabel = chapter.title === label || chapter.title === `${chapter.month}월` || (year != null && chapter.title === `${year}년 ${chapter.month}월`)
  return { label, title: sameAsLabel ? '' : chapter.title }
}

function pagePlacementByPhoto(pages: BookPage[]) {
  const placements = new Map<string, { pageId: string; number: number }>()
  pages.forEach((page, index) => {
    for (const id of page.photoIds) {
      if (!placements.has(id) || page.type === 'photos') {
        placements.set(id, { pageId: page.id, number: index + 1 })
      }
    }
  })
  return placements
}

function readDroppedPhotoIds(event: React.DragEvent) {
  const many = event.dataTransfer.getData('photo/ids')
  if (many) {
    try {
      const parsed = JSON.parse(many) as unknown
      if (Array.isArray(parsed)) return parsed.filter((id): id is string => typeof id === 'string' && Boolean(id))
    } catch {
      /* ignore */
    }
  }
  const one = event.dataTransfer.getData('photo/id')
  return one ? [one] : []
}

function bookYearFromPhotos(photos: Photo[]) {
  const counts = new Map<number, number>()
  for (const photo of photos) {
    const year = new Date(photo.capturedAt).getFullYear()
    if (Number.isNaN(year)) continue
    counts.set(year, (counts.get(year) ?? 0) + 1)
  }
  if (!counts.size) return CURRENT_YEAR
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0]
}

function existingBookPeriod(photos: Photo[]) {
  const stamps = photos
    .map((photo) => new Date(photo.capturedAt))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime())
  if (!stamps.length) return '저장된 작업'
  const start = stamps[0]
  const end = stamps[stamps.length - 1]
  const format = (date: Date) => `${date.getFullYear()}년 ${date.getMonth() + 1}월`
  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) return format(start)
  if (start.getFullYear() === end.getFullYear()) {
    return `${start.getFullYear()}년 ${start.getMonth() + 1}월 – ${end.getMonth() + 1}월`
  }
  return `${format(start)} – ${format(end)}`
}

function libraryEntries(photos: Photo[]) {
  const sorted = [...photos].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
  const entries: Array<
    | { type: 'month'; key: string; label: string }
    | { type: 'day'; key: string; label: string }
    | { type: 'photo'; photo: Photo }
  > = []
  let monthKey = ''
  let dayKey = ''
  for (const photo of sorted) {
    const date = new Date(photo.capturedAt)
    if (Number.isNaN(date.getTime())) {
      entries.push({ type: 'photo', photo })
      continue
    }
    const nextMonth = `${date.getFullYear()}-${date.getMonth()}`
    const nextDay = `${nextMonth}-${date.getDate()}`
    if (nextMonth !== monthKey) {
      monthKey = nextMonth
      dayKey = ''
      entries.push({
        type: 'month',
        key: nextMonth,
        label: `${date.getFullYear()}년 ${date.getMonth() + 1}월`,
      })
    }
    if (nextDay !== dayKey) {
      dayKey = nextDay
      entries.push({ type: 'day', key: nextDay, label: `${date.getDate()}일` })
    }
    entries.push({ type: 'photo', photo })
  }
  return entries
}

function imageSrc(photo: Photo, exportIndex?: number, printUrls?: Record<string, string>) {
  if (exportIndex !== undefined && printUrls?.[photo.id]) return printUrls[photo.id]
  return photo.thumbUrl || photo.url
}

function PagePaper({ page, chapter, editable = false, drawing = false, penColor = '#2b2824', penSize = 1.2, onOpenLive, onCrop, onCloseCrop, onSelectPhoto, croppingPhotoId, selectedPhotoId, exportIndex, printUrls, pageNumber = 1, placeRevision = 0 }: {
  page: BookPage
  chapter?: Chapter
  editable?: boolean
  drawing?: boolean
  penColor?: string
  penSize?: number
  onOpenLive?: (photo: Photo) => void
  onCrop?: (photo: Photo) => void
  onCloseCrop?: () => void
  onSelectPhoto?: (id: string) => void
  croppingPhotoId?: string
  selectedPhotoId?: string
  exportIndex?: number
  printUrls?: Record<string, string>
  pageNumber?: number
  placeRevision?: number
}) {
  const {
    photos, updateChapter, updatePhotoFrame, updatePhotoFrames, setLayoutLock, setPhotoCrop, rotatePhoto,
    addPhotoToPage, unplacePhoto, swapPhotoPositions, bookSize, orientation, marginMm,
    pageNotes, updatePageNote, removePageNote, pageCaptions, updatePageCaption,
    pageStickers, updatePageSticker, removePageSticker, pageMaps, updatePageMap, removePageMap,
  } = useBookStore(useShallow((state) => ({
    photos: state.photos,
    updateChapter: state.updateChapter,
    updatePhotoFrame: state.updatePhotoFrame,
    updatePhotoFrames: state.updatePhotoFrames,
    setLayoutLock: state.setLayoutLock,
    setPhotoCrop: state.setPhotoCrop,
    rotatePhoto: state.rotatePhoto,
    addPhotoToPage: state.addPhotoToPage,
    unplacePhoto: state.unplacePhoto,
    swapPhotoPositions: state.swapPhotoPositions,
    bookSize: state.bookSize,
    orientation: state.orientation,
    marginMm: state.marginMm,
    pageNotes: state.pageNotes,
    updatePageNote: state.updatePageNote,
    removePageNote: state.removePageNote,
    pageCaptions: state.pageCaptions,
    updatePageCaption: state.updatePageCaption,
    pageStickers: state.pageStickers,
    updatePageSticker: state.updatePageSticker,
    removePageSticker: state.removePageSticker,
    pageMaps: state.pageMaps,
    updatePageMap: state.updatePageMap,
    removePageMap: state.removePageMap,
  })))
  const pageFrame = useBookStore((state) => state.pageFrame)
  const gridRef = useRef<HTMLDivElement>(null)
  const [measuredRects, setMeasuredRects] = useState<Record<string, PhotoFrame>>({})
  const measureKey = page.type === 'photos' ? `${page.layoutId ?? ''}|${page.photoIds.join(',')}` : ''
  useLayoutEffect(() => {
    if (!editable || page.type !== 'photos' || page.layoutId === 'adaptive-flow') {
      setMeasuredRects((current) => (Object.keys(current).length ? {} : current))
      return
    }
    const grid = gridRef.current
    if (!grid || grid.getBoundingClientRect().height < 20) return
    const next: Record<string, PhotoFrame> = {}
    for (const id of page.photoIds) {
      const cell = grid.querySelector<HTMLElement>(`[data-photo-id="${id}"]`)
      if (!cell) return
      next[id] = frameFromElements(cell, grid)
    }
    setMeasuredRects((current) => (rectsClose(current, next) ? current : next))
  }, [editable, measureKey, page.layoutId, page.photoIds, page.type])
  const items = page.photoIds.map((id) => photos.find((photo) => photo.id === id)).filter(Boolean) as Photo[]
  const chapterPhotos = chapter?.photoIds.map((id) => photos.find((photo) => photo.id === id)).filter(Boolean) as Photo[] ?? []
  const chapterYear = chapterPhotos[0]?.capturedAt.slice(0, 4) ?? CURRENT_YEAR
  const ratio = orientation === 'portrait' ? bookSize.widthMm / bookSize.heightMm : bookSize.heightMm / bookSize.widthMm
  const style = { '--page-ratio': ratio, '--page-padding': `${Math.max(12, marginMm * 2.4)}px` } as React.CSSProperties
  const preserveFlowAspect = (page.flowAspect ?? 'locked') === 'locked'
  const adaptiveRects = page.layoutId === 'adaptive-flow' ? computeAdaptiveLayout(items, ratio, preserveFlowAspect) : []
  const activeAnchorId = [...items]
    .filter((photo) => photo.freeFrame)
    .sort((a, b) => (b.framePriority ?? 0) - (a.framePriority ?? 0))[0]?.id
  const rectById: Record<string, PhotoFrame> = page.layoutId === 'adaptive-flow'
    ? Object.fromEntries(items.flatMap((photo, index) => (adaptiveRects[index] ? [[photo.id, adaptiveRects[index]]] : [])))
    : measuredRects
  const lockedIds = new Set(items.filter((photo) => photo.layoutLocked).map((photo) => photo.id))
  const gutters = editable && !drawing
    ? findPhotoGutters(items.flatMap((photo) => (rectById[photo.id] ? [{ id: photo.id, rect: rectById[photo.id] }] : [])))
      .filter((gutter) => gutter.before.some((id) => !lockedIds.has(id)) || gutter.after.some((id) => !lockedIds.has(id)))
    : []

  const cropOpen = Boolean(editable && croppingPhotoId)

  if (page.type === 'year-months') {
    const yearLabel = items[0] ? new Date(items[0].capturedAt).getFullYear() : chapterYear
    return (
      <article className="book-page year-months-page" style={style} data-export-page={exportIndex}>
        <header className="year-page-head">
          <span>THE YEAR IN FRAMES</span>
          <h2>{yearLabel}년의 달들</h2>
          <p>매달을 대표하는 사진으로 한 해를 펼칩니다.</p>
        </header>
        <div className={`year-months-grid count-${Math.min(items.length, 12)}`}>
          {items.map((photo) => {
            const month = new Date(photo.capturedAt).getMonth() + 1
            return (
              <figure key={photo.id} className="year-month-card">
                <img src={imageSrc(photo, exportIndex, printUrls)} alt="" style={photoStyle(photo)} />
                <figcaption>
                  <b>{String(month).padStart(2, '0')}</b>
                  <span>{month}월</span>
                </figcaption>
              </figure>
            )
          })}
        </div>
        <PageNotes pageId={page.id} notes={pageNotes[page.id] ?? []} editable={editable} updatePageNote={updatePageNote} removePageNote={removePageNote} />
        <PageStickersLayer pageId={page.id} stickers={pageStickers[page.id] ?? []} editable={editable} update={updatePageSticker} remove={removePageSticker} />
        <PageDrawing pageId={page.id} active={Boolean(editable && drawing)} color={penColor} size={penSize} ratio={ratio} />
        <PageFooter pageId={page.id} photos={items} chapter={chapter} pageNumber={pageNumber} placeRevision={placeRevision} editable={editable} caption={pageCaptions[page.id]} updatePageCaption={updatePageCaption} />
        <FrameLayer frame={pageFrame} />
      </article>
    )
  }
  if (page.type === 'year-map') {
    const yearLabel = items[0] ? new Date(items[0].capturedAt).getFullYear() : chapterYear
    return (
      <article className="book-page map-page year-map-page" style={style} data-export-page={exportIndex}>
        <div className="map-title">
          <span>PLACES OF {yearLabel}</span>
          <ChapterTitle chapter={chapter} editable={editable} updateChapter={updateChapter} />
        </div>
        <TripMap
          photos={items.length ? items : chapterPhotos}
          showPhotos
          showRoute={false}
          forExport={exportIndex !== undefined}
        />
        <PageNotes pageId={page.id} notes={pageNotes[page.id] ?? []} editable={editable} updatePageNote={updatePageNote} removePageNote={removePageNote} />
        <PageStickersLayer pageId={page.id} stickers={pageStickers[page.id] ?? []} editable={editable} update={updatePageSticker} remove={removePageSticker} />
        <PageDrawing pageId={page.id} active={Boolean(editable && drawing)} color={penColor} size={penSize} ratio={ratio} />
        <PageFooter pageId={page.id} photos={items} chapter={chapter} pageNumber={pageNumber} placeRevision={placeRevision} editable={editable} caption={pageCaptions[page.id]} updatePageCaption={updatePageCaption} />
        <FrameLayer frame={pageFrame} />
      </article>
    )
  }
  if (page.type === 'intro') {
    const cover = items[0]
    return (
      <article className="book-page intro-page" style={style} data-export-page={exportIndex}>
        {cover && <img className="cover-image" src={imageSrc(cover, exportIndex, printUrls)} alt="" style={photoStyle(cover)} />}
        <div className="cover-shade" />
        <div className="cover-copy">
          <span>{chapter?.type === 'trip' ? 'JOURNEY' : `${chapter?.month?.toString().padStart(2, '0')} / ${chapterYear}`}</span>
          <ChapterTitle chapter={chapter} editable={editable} updateChapter={updateChapter} />
          {editable ? (
            <textarea
              placeholder="이 시기의 중요한 일을 기록해보세요…"
              value={chapter?.note}
              onChange={(event) => chapter && updateChapter(chapter.id, { note: event.target.value })}
            />
          ) : chapter?.note && <p>{chapter.note}</p>}
        </div>
        <PageNotes pageId={page.id} notes={pageNotes[page.id] ?? []} editable={editable} updatePageNote={updatePageNote} removePageNote={removePageNote} />
        <PageStickersLayer pageId={page.id} stickers={pageStickers[page.id] ?? []} editable={editable} update={updatePageSticker} remove={removePageSticker} />
        <PageMapLayer pageId={page.id} widget={pageMaps[page.id]} photos={chapterPhotos.length ? chapterPhotos : items} editable={editable} forExport={exportIndex !== undefined} update={updatePageMap} remove={removePageMap} />
        <PageDrawing pageId={page.id} active={Boolean(editable && drawing)} color={penColor} size={penSize} ratio={ratio} />
        <PageFooter pageId={page.id} photos={chapterPhotos.length ? chapterPhotos : items} chapter={chapter} pageNumber={pageNumber} placeRevision={placeRevision} editable={editable} caption={pageCaptions[page.id]} updatePageCaption={updatePageCaption} />
        <FrameLayer frame={pageFrame} />
      </article>
    )
  }
  if (page.type === 'map') {
    return (
      <article className="book-page map-page" style={style} data-export-page={exportIndex}>
        <div className="map-title"><span>OUR ROUTE</span><ChapterTitle chapter={chapter} editable={editable} updateChapter={updateChapter} /></div>
        <TripMap photos={chapterPhotos} forExport={exportIndex !== undefined} />
        <PageNotes pageId={page.id} notes={pageNotes[page.id] ?? []} editable={editable} updatePageNote={updatePageNote} removePageNote={removePageNote} />
        <PageStickersLayer pageId={page.id} stickers={pageStickers[page.id] ?? []} editable={editable} update={updatePageSticker} remove={removePageSticker} />
        <PageDrawing pageId={page.id} active={Boolean(editable && drawing)} color={penColor} size={penSize} ratio={ratio} />
        <PageFooter pageId={page.id} photos={chapterPhotos} chapter={chapter} pageNumber={pageNumber} placeRevision={placeRevision} editable={editable} caption={pageCaptions[page.id]} updatePageCaption={updatePageCaption} />
        <FrameLayer frame={pageFrame} />
      </article>
    )
  }
  return (
    <article
      className={`book-page photo-page${cropOpen ? ' has-inline-crop' : ''}`}
      style={style}
      data-export-page={exportIndex}
      onDragOver={(event) => editable && event.preventDefault()}
      onDrop={(event) => {
        if (!editable) return
        for (const id of readDroppedPhotoIds(event)) addPhotoToPage(id, page.id)
      }}
    >
      <ChapterTitle chapter={chapter} editable={editable} updateChapter={updateChapter} />
      <div className={`photo-grid layout-${page.layoutId ?? 'many-tiles'}${items.length ? '' : ' is-empty'}`} ref={gridRef}>
        {!items.length && editable && (
          <div className="empty-page-hint">
            <ImagePlus />
            <span>사진을 여기로 끌어다 놓으세요</span>
          </div>
        )}
        {items.map((photo, index) => (
          <div
            key={photo.id}
            className={`photo-cell size-${photo.size} ${editable ? 'editable-photo' : ''} ${photo.layoutLocked ? 'is-locked' : ''} ${activeAnchorId === photo.id ? 'free-anchor' : ''} ${selectedPhotoId === photo.id ? 'is-selected' : ''} ${croppingPhotoId === photo.id ? 'crop-editing' : ''}`}
            style={page.layoutId === 'adaptive-flow' ? adaptiveCellStyle(adaptiveRects[index], activeAnchorId === photo.id) : undefined}
            tabIndex={editable ? 0 : -1}
            data-photo-id={photo.id}
            draggable={false}
            onDoubleClick={(event) => {
              if (!editable || drawing) return
              if ((event.target as HTMLElement).closest('button, input, textarea')) return
              event.preventDefault()
              window.getSelection()?.removeAllRanges()
              onCrop?.(photo)
            }}
            onPointerDown={(event) => {
              if (!editable || drawing) return
              if ((event.target as HTMLElement).closest('button, input, textarea')) return
              if (event.detail > 1) {
                event.preventDefault()
                window.getSelection()?.removeAllRanges()
                onCrop?.(photo)
                return
              }
              onSelectPhoto?.(photo.id)
              if (croppingPhotoId === photo.id) beginInlineCrop(event, photo, setPhotoCrop)
              else if (!photo.layoutLocked) beginMove(event, photo, updatePhotoFrame)
            }}
            onDragOver={(event) => {
              if (!editable) return
              event.preventDefault()
              event.currentTarget.classList.add('drop-target')
            }}
            onDragLeave={(event) => event.currentTarget.classList.remove('drop-target')}
            onDrop={(event) => {
              if (!editable) return
              event.preventDefault()
              event.stopPropagation()
              event.currentTarget.classList.remove('drop-target')
              for (const sourceId of readDroppedPhotoIds(event)) addPhotoToPage(sourceId, page.id)
            }}
          >
            <div className="photo-media">
              <img
                src={imageSrc(photo, exportIndex, printUrls)}
                alt={photo.name}
                draggable={false}
                style={photoStyle(photo, adaptiveRects[index], ratio, preserveFlowAspect)}
              />
            </div>
            {editable && photo.analysis && (
              <span className={`scene-badge scene-${photo.analysis.scene}`}>
                {photo.analysis.scene === 'people' ? <Users /> : photo.analysis.scene === 'landscape' ? <Mountain /> : <LayoutTemplate />}
                <span className="action-label">{sceneLabel(photo.analysis.scene)}</span>
              </span>
            )}
            {editable && (
              <div className="photo-actions">
                {photo.isLive && (
                  <button type="button" onClick={() => onOpenLive?.(photo)} title="실시간 사진 장면 선택" aria-label="실시간 사진 장면 선택">
                    <span className="action-label">LIVE</span>
                  </button>
                )}
                <button
                  type="button"
                  className={`lock-action${photo.layoutLocked ? ' active' : ''}`}
                  title={photo.layoutLocked ? '크기와 위치 고정 해제' : '크기와 위치 고정'}
                  aria-label={photo.layoutLocked ? '크기와 위치 고정 해제' : '크기와 위치 고정'}
                  aria-pressed={photo.layoutLocked}
                  onClick={(event) => {
                    const cell = event.currentTarget.closest<HTMLElement>('.photo-cell')
                    const grid = cell?.closest<HTMLElement>('.photo-grid')
                    if (!cell || !grid) return
                    const frame = page.layoutId === 'adaptive-flow' && adaptiveRects[index]
                      ? adaptiveRects[index]
                      : frameFromElements(cell, grid)
                    setLayoutLock(photo.id, !photo.layoutLocked, frame)
                  }}
                >
                  <Lock />
                </button>
                <button type="button" onClick={() => onCrop?.(photo)} title="사진 자르기" aria-label="사진 자르기"><Crop /></button>
                <button
                  type="button"
                  title="시계 방향으로 90도 회전"
                  aria-label="사진 회전"
                  onClick={() => rotatePhoto(photo.id)}
                >
                  <RotateCw />
                </button>
                {chapter?.type === 'month' && (
                  <button type="button" onClick={() => updateChapter(chapter.id, { coverPhotoId: photo.id })} title="이달의 대표 사진" aria-label="이달의 대표 사진">
                    <span className="action-label">대표</span>
                  </button>
                )}
                <button type="button" className="delete-action" onClick={() => unplacePhoto(photo.id)} title="페이지에서 빼기" aria-label="페이지에서 빼기"><Trash2 /></button>
              </div>
            )}
            {editable && selectedPhotoId && selectedPhotoId !== photo.id && (
              <button
                type="button"
                className="swap-photo"
                onPointerDown={(event) => {
                  event.stopPropagation()
                  event.preventDefault()
                  swapPhotoPositions(selectedPhotoId, photo.id)
                }}
                title="선택한 사진과 이 사진의 자리만 바꾸기"
              >
                바꾸기
              </button>
            )}
            {editable && croppingPhotoId === photo.id && (
              <div className="inline-crop-controls" onPointerDown={(event) => event.stopPropagation()}>
                <div><strong>자르기</strong><span>드래그로 이동 · 휠로 확대/축소</span></div>
                <label>
                  <span>확대</span>
                  <input
                    type="range"
                    min={1}
                    max={2.5}
                    step={0.01}
                    value={photo.crop?.zoom ?? 1}
                    onChange={(event) => setPhotoCrop(photo.id, {
                      zoom: Number(event.target.value),
                      x: photo.crop?.x ?? photo.analysis?.focalPoint.x ?? 0.5,
                      y: photo.crop?.y ?? photo.analysis?.focalPoint.y ?? 0.5,
                    })}
                  />
                </label>
                <div className="inline-crop-actions">
                  <button onClick={() => setPhotoCrop(photo.id, { zoom: 1, x: 0.5, y: 0.5 })}>초기화</button>
                  <button className="crop-done" onClick={onCloseCrop}>완료</button>
                </div>
              </div>
            )}
            {editable && photo.layoutLocked && <span className="layout-lock-badge"><Lock /></span>}
            {editable && !photo.layoutLocked && (
              <button
                className="resize-handle"
                title="드래그해서 사진 크기 조절"
                aria-label="사진 크기 조절"
                onPointerDown={(event) => beginResize(event, photo, updatePhotoFrame)}
              >
                <Grip />
              </button>
            )}
          </div>
        ))}
        {gutters.map((gutter) => (
          <button
            key={gutter.id}
            type="button"
            className={`photo-gutter axis-${gutter.axis}`}
            style={gutterStyle(gutter)}
            aria-label="사진 사이 크기 조절"
            onPointerDown={(event) => beginGutterDrag(event, gutter, rectById, items, updatePhotoFrames)}
          />
        ))}
      </div>
      <PageNotes pageId={page.id} notes={pageNotes[page.id] ?? []} editable={editable} updatePageNote={updatePageNote} removePageNote={removePageNote} />
      <PageStickersLayer pageId={page.id} stickers={pageStickers[page.id] ?? []} editable={editable} update={updatePageSticker} remove={removePageSticker} />
      <PageMapLayer pageId={page.id} widget={pageMaps[page.id]} photos={items} editable={editable} forExport={exportIndex !== undefined} update={updatePageMap} remove={removePageMap} />
      <PageDrawing pageId={page.id} active={Boolean(editable && drawing)} color={penColor} size={penSize} ratio={ratio} />
      <PageFooter pageId={page.id} photos={items} chapter={chapter} pageNumber={pageNumber} placeRevision={placeRevision} editable={editable} caption={pageCaptions[page.id]} updatePageCaption={updatePageCaption} />
      <FrameLayer frame={pageFrame} />
    </article>
  )
}

function StickerPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  return (
    <div className="sticker-picker" role="listbox" aria-label="스티커 고르기">
      <div className="sticker-picker-head">
        <strong>스티커</strong>
        <button type="button" onClick={onClose} aria-label="닫기">×</button>
      </div>
      <div className="sticker-grid">
        {STICKER_EMOJIS.map((emoji) => (
          <button key={emoji} type="button" onClick={() => onPick(emoji)} aria-label={`스티커 ${emoji}`}>{emoji}</button>
        ))}
      </div>
    </div>
  )
}

function PageStickersLayer({ pageId, stickers, editable, update, remove }: {
  pageId: string
  stickers: PageSticker[]
  editable: boolean
  update: (pageId: string, stickerId: string, patch: Partial<PageSticker>) => void
  remove: (pageId: string, stickerId: string) => void
}) {
  return stickers.map((sticker) => (
    <div
      key={sticker.id}
      className={`page-sticker${editable ? ' is-editing' : ''}`}
      style={{
        left: `${sticker.x * 100}%`,
        top: `${sticker.y * 100}%`,
        width: `${sticker.size * 100}%`,
        transform: `rotate(${sticker.rotation ?? 0}deg)`,
      }}
      onPointerDown={(event) => {
        if (!editable) return
        if ((event.target as HTMLElement).closest('button')) return
        beginStickerDrag(event, pageId, sticker, update)
      }}
    >
      <span aria-hidden>{sticker.emoji}</span>
      {editable && (
        <>
          <button type="button" className="sticker-rotate" title="돌리기" onClick={() => update(pageId, sticker.id, { rotation: (((sticker.rotation ?? 0) + 15) % 360) })}>↻</button>
          <button type="button" className="sticker-grow" title="크게" onClick={() => update(pageId, sticker.id, { size: Math.min(0.4, sticker.size + 0.03) })}>+</button>
          <button type="button" className="sticker-shrink" title="작게" onClick={() => update(pageId, sticker.id, { size: Math.max(0.06, sticker.size - 0.03) })}>−</button>
          <button type="button" className="note-delete" onClick={() => remove(pageId, sticker.id)} aria-label="스티커 삭제">×</button>
        </>
      )}
    </div>
  ))
}

function beginStickerDrag(
  event: React.PointerEvent<HTMLDivElement>,
  pageId: string,
  sticker: PageSticker,
  update: (pageId: string, stickerId: string, patch: Partial<PageSticker>) => void,
) {
  event.preventDefault()
  event.stopPropagation()
  const el = event.currentTarget
  const page = el.closest<HTMLElement>('.book-page')
  if (!page) return
  const rect = page.getBoundingClientRect()
  const startX = event.clientX
  const startY = event.clientY
  const originX = sticker.x
  const originY = sticker.y
  el.setPointerCapture(event.pointerId)
  const move = (moveEvent: PointerEvent) => {
    update(pageId, sticker.id, {
      x: Math.min(0.92, Math.max(0.02, originX + (moveEvent.clientX - startX) / rect.width)),
      y: Math.min(0.92, Math.max(0.02, originY + (moveEvent.clientY - startY) / rect.height)),
    })
  }
  const end = () => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', end)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', end)
}

function CoverStickersLayer({ panel, stickers, editable, update, remove }: {
  panel: CoverPanel
  stickers: CoverSticker[]
  editable: boolean
  update: (stickerId: string, patch: Partial<CoverSticker>) => void
  remove: (stickerId: string) => void
}) {
  return stickers.filter((item) => item.panel === panel).map((sticker) => (
    <div
      key={sticker.id}
      className={`cover-sticker${editable ? ' is-editing' : ''}`}
      style={{
        left: `${sticker.x * 100}%`,
        top: `${sticker.y * 100}%`,
        width: `${sticker.size * 100}%`,
        transform: `rotate(${sticker.rotation ?? 0}deg)`,
      }}
      onPointerDown={(event) => {
        if (!editable) return
        if ((event.target as HTMLElement).closest('button')) return
        beginCoverStickerDrag(event, sticker, update)
      }}
    >
      <span aria-hidden>{sticker.emoji}</span>
      {editable && (
        <>
          <button type="button" className="sticker-grow" title="크게" onClick={() => update(sticker.id, { size: Math.min(0.45, sticker.size + 0.03) })}>+</button>
          <button type="button" className="note-delete" onClick={() => remove(sticker.id)} aria-label="스티커 삭제">×</button>
        </>
      )}
    </div>
  ))
}

function beginCoverStickerDrag(
  event: React.PointerEvent<HTMLDivElement>,
  sticker: CoverSticker,
  update: (stickerId: string, patch: Partial<CoverSticker>) => void,
) {
  event.preventDefault()
  event.stopPropagation()
  const el = event.currentTarget
  const panel = el.closest<HTMLElement>('.jacket-panel')
  if (!panel) return
  const rect = panel.getBoundingClientRect()
  const startX = event.clientX
  const startY = event.clientY
  const originX = sticker.x
  const originY = sticker.y
  el.setPointerCapture(event.pointerId)
  const move = (moveEvent: PointerEvent) => {
    update(sticker.id, {
      x: Math.min(0.9, Math.max(0.02, originX + (moveEvent.clientX - startX) / rect.width)),
      y: Math.min(0.9, Math.max(0.02, originY + (moveEvent.clientY - startY) / rect.height)),
    })
  }
  const end = () => {
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', end)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', end)
}

function PageMapLayer({ pageId, widget, photos, editable, forExport = false, update, remove }: {
  pageId: string
  widget?: PageMapWidget
  photos: Photo[]
  editable: boolean
  forExport?: boolean
  update: (pageId: string, patch: Partial<PageMapWidget>) => void
  remove: (pageId: string) => void
}) {
  if (!widget) return null
  return (
    <div
      className={`page-map-widget${editable ? ' is-editing' : ''}`}
      style={{
        left: `${widget.x * 100}%`,
        top: `${widget.y * 100}%`,
        width: `${widget.width * 100}%`,
        height: `${widget.height * 100}%`,
      }}
    >
      {editable && (
        <div className="page-map-tools">
          <button
            type="button"
            className="map-move-handle"
            aria-label="지도 위젯 이동"
            title="여기 잡고 드래그하면 지도 칸을 옮깁니다"
            onPointerDown={(event) => beginMapDrag(event, pageId, widget, update)}
          >
            옮기기
          </button>
          <span>지도 안에서는 드래그·줌으로 위치를 맞춥니다</span>
          <button type="button" onClick={() => remove(pageId)} aria-label="지도 빼기">×</button>
        </div>
      )}
      <div className="page-map-body">
        <TripMap
          photos={photos}
          interactive={!forExport}
          forExport={forExport}
          sizeToken={`${widget.width.toFixed(2)}x${widget.height.toFixed(2)}`}
        />
      </div>
      {editable && (
        <>
          <button
            type="button"
            className="map-resize map-resize-se"
            aria-label="지도 크기 조절"
            onPointerDown={(event) => beginMapResize(event, pageId, widget, update, 'se')}
          />
          <button
            type="button"
            className="map-resize map-resize-e"
            aria-label="지도 가로 크기 조절"
            onPointerDown={(event) => beginMapResize(event, pageId, widget, update, 'e')}
          />
          <button
            type="button"
            className="map-resize map-resize-s"
            aria-label="지도 세로 크기 조절"
            onPointerDown={(event) => beginMapResize(event, pageId, widget, update, 's')}
          />
        </>
      )}
    </div>
  )
}

function beginMapDrag(
  event: React.PointerEvent<HTMLElement>,
  pageId: string,
  widget: PageMapWidget,
  update: (pageId: string, patch: Partial<PageMapWidget>) => void,
) {
  event.preventDefault()
  event.stopPropagation()
  const handle = event.currentTarget
  const widgetEl = handle.closest<HTMLElement>('.page-map-widget')
  const page = handle.closest<HTMLElement>('.book-page')
  if (!page) return
  const rect = page.getBoundingClientRect()
  const startX = event.clientX
  const startY = event.clientY
  const originX = widget.x
  const originY = widget.y
  const width = widget.width
  const height = widget.height
  widgetEl?.classList.add('is-dragging')
  handle.setPointerCapture(event.pointerId)
  const move = (moveEvent: PointerEvent) => {
    update(pageId, {
      x: Math.min(1 - width, Math.max(0, originX + (moveEvent.clientX - startX) / rect.width)),
      y: Math.min(1 - height, Math.max(0, originY + (moveEvent.clientY - startY) / rect.height)),
    })
  }
  const end = () => {
    widgetEl?.classList.remove('is-dragging')
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', end)
    handle.removeEventListener('pointercancel', end)
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', end)
  handle.addEventListener('pointercancel', end)
}

function beginMapResize(
  event: React.PointerEvent<HTMLButtonElement>,
  pageId: string,
  widget: PageMapWidget,
  update: (pageId: string, patch: Partial<PageMapWidget>) => void,
  edge: 'se' | 'e' | 's' = 'se',
) {
  event.preventDefault()
  event.stopPropagation()
  const handle = event.currentTarget
  const page = handle.closest<HTMLElement>('.book-page')
  if (!page) return
  const rect = page.getBoundingClientRect()
  const originW = widget.width
  const originH = widget.height
  const originX = widget.x
  const originY = widget.y
  const startX = event.clientX
  const startY = event.clientY
  handle.setPointerCapture(event.pointerId)
  const move = (moveEvent: PointerEvent) => {
    const dx = (moveEvent.clientX - startX) / rect.width
    const dy = (moveEvent.clientY - startY) / rect.height
    const nextWidth = edge === 's' ? originW : Math.min(1 - originX, Math.max(0.16, originW + dx))
    const nextHeight = edge === 'e' ? originH : Math.min(1 - originY, Math.max(0.14, originH + dy))
    update(pageId, { width: nextWidth, height: nextHeight })
  }
  const end = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', end)
    handle.removeEventListener('pointercancel', end)
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', end)
  handle.addEventListener('pointercancel', end)
}

function ChapterTitle({ chapter, editable, updateChapter }: {
  chapter?: Chapter
  editable: boolean
  updateChapter: (id: string, patch: Partial<Chapter>) => void
}) {
  if (!chapter) return null
  if (!editable) return <h2>{chapter.title}</h2>
  return (
    <input
      className="chapter-title"
      aria-label="챕터 이름"
      value={chapter.title}
      placeholder="챕터 이름"
      onChange={(event) => updateChapter(chapter.id, { title: event.target.value })}
    />
  )
}

function PageFooter({ pageId, photos, chapter, pageNumber, placeRevision, editable = false, caption, updatePageCaption }: {
  pageId: string
  photos: Photo[]
  chapter?: Chapter
  pageNumber: number
  placeRevision: number
  editable?: boolean
  caption?: PageCaption
  updatePageCaption: (pageId: string, patch: Partial<PageCaption>) => void
}) {
  const dates = [...new Set(photos.map((photo) => photo.capturedAt.slice(0, 10)))].sort()
  const placeNames = [...new Set(photos.flatMap((photo) => (
    photo.latitude == null || photo.longitude == null ? [] : [cachedPlace(photo.latitude, photo.longitude)]
  )).filter(Boolean))]
  const tripPlace = chapter?.type === 'trip' ? chapter.title.split(' · ')[0] : ''
  const date = caption?.date ?? formatFooterDate(dates)
  const place = caption?.place ?? (placeNames.slice(0, 2).join(' · ') || tripPlace)
  const pageLabel = caption?.page ?? String(pageNumber)
  return (
    <footer className="page-footer" data-places={placeRevision}>
      {editable ? (
        <>
          <input aria-label="날짜" value={date} onChange={(event) => updatePageCaption(pageId, { date: event.target.value })} />
          <input aria-label="장소" value={place} onChange={(event) => updatePageCaption(pageId, { place: event.target.value })} />
          <input aria-label="페이지" value={pageLabel} onChange={(event) => updatePageCaption(pageId, { page: event.target.value })} />
        </>
      ) : (
        <>
          <span>{date}</span>
          <span>{place}</span>
          <b>{pageLabel}</b>
        </>
      )}
    </footer>
  )
}

function formatFooterDate(dates: string[]) {
  if (!dates.length) return ''
  const start = new Date(`${dates[0]}T00:00:00`)
  const end = new Date(`${dates[dates.length - 1]}T00:00:00`)
  const head = `${start.getFullYear()}. ${start.getMonth() + 1}. ${start.getDate()}.`
  if (dates[0] === dates[dates.length - 1]) return head
  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
    return `${head} – ${end.getDate()}.`
  }
  return `${head} – ${end.getFullYear()}. ${end.getMonth() + 1}. ${end.getDate()}.`
}

const MEMO_LOOK = {
  yellow: { text: '#3d3114', background: '#ffe58a' },
  pink: { text: '#5c3140', background: '#ffd0d8' },
  blue: { text: '#243e5c', background: '#d7ecff' },
  cream: { text: '#4a3b22', background: '#fff1d2' },
} as const

function hexToRgba(hex: string, alpha: number) {
  const channels = hex.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i)
  if (!channels) return `rgba(255,248,238,${alpha})`
  return `rgba(${parseInt(channels[1], 16)},${parseInt(channels[2], 16)},${parseInt(channels[3], 16)},${alpha})`
}

function noteLook(note: PageNote) {
  const preset = MEMO_LOOK[note.color] ?? MEMO_LOOK.yellow
  const text = note.textColor ?? preset.text
  const background = note.backgroundColor ?? preset.background
  const alpha = note.backgroundAlpha ?? 1
  return { text, background, alpha, css: hexToRgba(background, alpha) }
}

function PageNotes({ pageId, notes, editable, updatePageNote, removePageNote }: {
  pageId: string
  notes: PageNote[]
  editable: boolean
  updatePageNote: (pageId: string, noteId: string, patch: Partial<PageNote>) => void
  removePageNote: (pageId: string, noteId: string) => void
}) {
  return notes.filter((note) => note.kind === 'memo').map((note) => {
    const look = noteLook(note)
    const memoWidth = note.width ?? 0.3
    const memoHeight = note.height ?? 0.24
    return (
      <div
        key={note.id}
        className={`page-note kind-memo color-${note.color}${editable ? ' is-editing' : ''}${note.y < 0.14 ? ' tools-below' : ''}`}
        style={{
          left: `${note.x * 100}%`,
          top: `${note.y * 100}%`,
          color: look.text,
          backgroundColor: look.css,
          width: `${memoWidth * 100}%`,
          height: `${memoHeight * 100}%`,
        }}
        onPointerDown={(event) => {
          if (!editable) return
          const target = event.target as HTMLElement
          if (target.closest('textarea, button, select, .note-tools')) return
          beginNoteDrag(event, pageId, note, updatePageNote)
        }}
      >
        {editable && (
          <div className="note-tools">
            <label className="note-swatch">
              글자
              <input
                type="color"
                aria-label="글자 색"
                value={look.text}
                onChange={(event) => updatePageNote(pageId, note.id, { textColor: event.target.value })}
              />
            </label>
            <label className="note-swatch">
              배경
              <input
                type="color"
                aria-label="배경 색"
                value={look.background}
                onChange={(event) => updatePageNote(pageId, note.id, {
                  backgroundColor: event.target.value,
                  backgroundAlpha: look.alpha === 0 ? 0.88 : look.alpha,
                })}
              />
            </label>
            <label className="note-opacity">
              투명
              <input
                type="range"
                min={0}
                max={100}
                aria-label="투명도"
                value={Math.round((1 - look.alpha) * 100)}
                onChange={(event) => updatePageNote(pageId, note.id, { backgroundAlpha: 1 - Number(event.target.value) / 100 })}
              />
            </label>
          </div>
        )}
        {editable ? (
          <textarea
            value={note.text}
            aria-label="메모"
            onChange={(event) => updatePageNote(pageId, note.id, { text: event.target.value })}
            onPointerDown={(event) => event.stopPropagation()}
          />
        ) : <p>{note.text}</p>}
        {editable && (
          <button
            type="button"
            className="note-resize"
            aria-label="메모 크기 조절"
            onPointerDown={(event) => beginNoteResize(event, pageId, note, updatePageNote)}
          />
        )}
        {editable && <button type="button" className="note-delete" onClick={() => removePageNote(pageId, note.id)} aria-label="삭제">×</button>}
      </div>
    )
  })
}

function beginNoteDrag(
  event: React.PointerEvent<HTMLDivElement>,
  pageId: string,
  note: PageNote,
  update: (pageId: string, noteId: string, patch: Partial<PageNote>) => void,
) {
  event.preventDefault()
  event.stopPropagation()
  const noteEl = event.currentTarget
  const page = noteEl.closest<HTMLElement>('.book-page')
  if (!page) return
  const rect = page.getBoundingClientRect()
  const startX = event.clientX
  const startY = event.clientY
  const originX = note.x
  const originY = note.y
  noteEl.setPointerCapture(event.pointerId)
  const spanX = note.width ?? 0.3
  const spanY = note.height ?? 0.24
  const move = (moveEvent: PointerEvent) => {
    update(pageId, note.id, {
      x: Math.min(Math.max(0.02, 1 - spanX), Math.max(0.02, originX + (moveEvent.clientX - startX) / rect.width)),
      y: Math.min(Math.max(0.02, 1 - spanY), Math.max(0.02, originY + (moveEvent.clientY - startY) / rect.height)),
    })
  }
  const end = () => {
    noteEl.removeEventListener('pointermove', move)
    noteEl.removeEventListener('pointerup', end)
  }
  noteEl.addEventListener('pointermove', move)
  noteEl.addEventListener('pointerup', end)
}

function beginNoteResize(
  event: React.PointerEvent<HTMLButtonElement>,
  pageId: string,
  note: PageNote,
  update: (pageId: string, noteId: string, patch: Partial<PageNote>) => void,
) {
  event.preventDefault()
  event.stopPropagation()
  const handle = event.currentTarget
  const page = handle.closest<HTMLElement>('.book-page')
  if (!page) return
  const rect = page.getBoundingClientRect()
  const originW = note.width ?? 0.3
  const originH = note.height ?? 0.24
  const startX = event.clientX
  const startY = event.clientY
  handle.setPointerCapture(event.pointerId)
  const move = (moveEvent: PointerEvent) => {
    update(pageId, note.id, {
      width: Math.min(1 - note.x, Math.max(0.16, originW + (moveEvent.clientX - startX) / rect.width)),
      height: Math.min(1 - note.y, Math.max(0.12, originH + (moveEvent.clientY - startY) / rect.height)),
    })
  }
  const end = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', end)
    handle.removeEventListener('pointercancel', end)
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', end)
  handle.addEventListener('pointercancel', end)
}

function MiniJacket({ year }: { year: number }) {
  const cover = useBookStore((state) => state.cover)
  const photos = useBookStore((state) => state.photos)
  const pages = useBookStore((state) => state.pages)
  const bookSize = useBookStore((state) => state.bookSize)
  const orientation = useBookStore((state) => state.orientation)
  const spread = coverSpread(bookSize, orientation, Math.max(pages.length, 1))
  const front = photos.find((photo) => photo.id === cover.frontPhotoId)
  const back = photos.find((photo) => photo.id === cover.backPhotoId)
  const spine = photos.find((photo) => photo.id === cover.spinePhotoId)
  const src = (photo?: Photo) => photo?.thumbUrl || photo?.url
  const stickers = cover.stickers ?? []
  const panelStickers = (panel: CoverPanel) => stickers.filter((sticker) => sticker.panel === panel)
  return (
    <div
      className="mini-jacket"
      style={{
        background: cover.backgroundColor,
        color: cover.textColor,
        aspectRatio: `${spread.spreadMm} / ${spread.heightMm}`,
        gridTemplateColumns: `${spread.widthMm}fr ${Math.max(spread.spineMm, 6)}fr ${spread.widthMm}fr`,
      }}
    >
      <div className="mini-jacket-panel">
        {back && <img src={src(back)} alt="" />}
        {(back || cover.backText) && <div className="mini-jacket-shade" />}
        <div className="mini-jacket-copy">
          {cover.backText ? <em>{cover.backText}</em> : !back ? <em className="is-placeholder">뒤</em> : null}
        </div>
        {panelStickers('back').map((sticker) => (
          <span
            key={sticker.id}
            className="mini-sticker"
            style={{
              left: `${sticker.x * 100}%`,
              top: `${sticker.y * 100}%`,
              width: `${sticker.size * 100}%`,
              transform: `translate(-50%, -50%) rotate(${sticker.rotation ?? 0}deg)`,
            }}
            aria-hidden
          >
            {sticker.emoji}
          </span>
        ))}
      </div>
      <div className="mini-jacket-spine">
        {spine && <img src={src(spine)} alt="" />}
        {spine && <div className="mini-jacket-shade" />}
        <i>{cover.spineText || cover.title || year}</i>
        {panelStickers('spine').map((sticker) => (
          <span
            key={sticker.id}
            className="mini-sticker"
            style={{
              left: `${sticker.x * 100}%`,
              top: `${sticker.y * 100}%`,
              width: `${Math.max(sticker.size, 0.35) * 100}%`,
              transform: `translate(-50%, -50%) rotate(${sticker.rotation ?? 0}deg)`,
            }}
            aria-hidden
          >
            {sticker.emoji}
          </span>
        ))}
      </div>
      <div className="mini-jacket-panel">
        {front && <img src={src(front)} alt="" />}
        <div className="mini-jacket-shade" />
        <div className="mini-jacket-copy">
          <b>{cover.title || year}</b>
          {cover.subtitle && <small>{cover.subtitle}</small>}
        </div>
        {panelStickers('front').map((sticker) => (
          <span
            key={sticker.id}
            className="mini-sticker"
            style={{
              left: `${sticker.x * 100}%`,
              top: `${sticker.y * 100}%`,
              width: `${sticker.size * 100}%`,
              transform: `translate(-50%, -50%) rotate(${sticker.rotation ?? 0}deg)`,
            }}
            aria-hidden
          >
            {sticker.emoji}
          </span>
        ))}
      </div>
    </div>
  )
}

function CoverBar({
  stickerPanel,
  onStickerPanel,
  decorOpen,
  onDecorOpen,
}: {
  stickerPanel: CoverPanel | null
  onStickerPanel: (panel: CoverPanel | null) => void
  decorOpen: boolean
  onDecorOpen: (open: boolean) => void
}) {
  const { photos, cover, updateCover, addCoverSticker } = useBookStore()
  return (
    <div className="cover-fields">
      <label>앞표지
        <select aria-label="앞표지 사진" value={cover.frontPhotoId ?? ''} onChange={(event) => updateCover({ frontPhotoId: event.target.value || undefined })}>
          <option value="">사진 없음</option>
          {photos.map((photo) => <option key={photo.id} value={photo.id}>{photo.name}</option>)}
        </select>
      </label>
      <label>책등
        <select aria-label="책등 사진" value={cover.spinePhotoId ?? ''} onChange={(event) => updateCover({ spinePhotoId: event.target.value || undefined })}>
          <option value="">색만</option>
          {photos.map((photo) => <option key={photo.id} value={photo.id}>{photo.name}</option>)}
        </select>
      </label>
      <label>뒤표지
        <select aria-label="뒤표지 사진" value={cover.backPhotoId ?? ''} onChange={(event) => updateCover({ backPhotoId: event.target.value || undefined })}>
          <option value="">사진 없음</option>
          {photos.map((photo) => <option key={photo.id} value={photo.id}>{photo.name}</option>)}
        </select>
      </label>
      <label className="note-swatch">배경<input type="color" aria-label="표지 배경" value={cover.backgroundColor} onChange={(event) => updateCover({ backgroundColor: event.target.value, themeId: 'custom' })} /></label>
      <label className="note-swatch">글자<input type="color" aria-label="표지 글자" value={cover.textColor} onChange={(event) => updateCover({ textColor: event.target.value, themeId: 'custom' })} /></label>
      <label className="note-opacity">제목
        <input
          type="range"
          min={22}
          max={64}
          aria-label="제목 크기"
          value={cover.titleSize ?? 42}
          onChange={(event) => updateCover({ titleSize: Number(event.target.value) })}
        />
      </label>
      <label className="note-opacity">부제
        <input
          type="range"
          min={12}
          max={28}
          aria-label="부제 크기"
          value={cover.subtitleSize ?? 16}
          onChange={(event) => updateCover({ subtitleSize: Number(event.target.value) })}
        />
      </label>
      <div className="cover-sticker-tools">
        <button
          type="button"
          className={decorOpen ? 'active' : ''}
          onClick={() => onDecorOpen(!decorOpen)}
        >
          표지 꾸미기
        </button>
        {(['front', 'spine', 'back'] as CoverPanel[]).map((panel) => (
          <button
            key={panel}
            type="button"
            className={stickerPanel === panel ? 'active' : ''}
            onClick={() => onStickerPanel(stickerPanel === panel ? null : panel)}
          >
            {panel === 'front' ? '앞 스티커' : panel === 'spine' ? '책등 스티커' : '뒤 스티커'}
          </button>
        ))}
      </div>
      {decorOpen && (
        <CoverDecorPicker
          cover={cover}
          onCoverChange={updateCover}
          onClose={() => onDecorOpen(false)}
        />
      )}
      {stickerPanel && (
        <StickerPicker
          onPick={(emoji) => {
            addCoverSticker(stickerPanel, emoji)
            onStickerPanel(null)
          }}
          onClose={() => onStickerPanel(null)}
        />
      )}
    </div>
  )
}

function BookJacket({ year, editable = false, printUrls, printing = false }: {
  year: number
  editable?: boolean
  printUrls?: Record<string, string>
  printing?: boolean
}) {
  const { cover, updateCover, updateCoverSticker, removeCoverSticker, photos, pages, bookSize, orientation } = useBookStore()
  const spread = coverSpread(bookSize, orientation, Math.max(pages.length, 1))
  const front = photos.find((photo) => photo.id === cover.frontPhotoId)
  const back = photos.find((photo) => photo.id === cover.backPhotoId)
  const spine = photos.find((photo) => photo.id === cover.spinePhotoId)
  const picture = (photo?: Photo) => photo && (printing && printUrls?.[photo.id] ? printUrls[photo.id] : (photo.thumbUrl || photo.url))
  const style = {
    '--page-ratio': spread.widthMm / spread.heightMm,
    '--jacket-ratio': spread.spreadMm / spread.heightMm,
    '--cover-title-size': `${cover.titleSize ?? 42}px`,
    '--cover-subtitle-size': `${cover.subtitleSize ?? 16}px`,
    background: cover.backgroundColor,
    color: cover.textColor,
    gridTemplateColumns: `${spread.widthMm}fr ${spread.spineMm}fr ${spread.widthMm}fr`,
  } as React.CSSProperties
  const stickers = cover.stickers ?? []
  return (
    <article className="book-jacket" style={style} data-export-page={printing ? 'jacket' : undefined}>
      <section
        className="jacket-panel jacket-back"
        onDragOver={(event) => editable && event.preventDefault()}
        onDrop={(event) => {
          const id = event.dataTransfer.getData('photo/id')
          if (id) updateCover({ backPhotoId: id })
        }}
      >
        {back && <img src={picture(back)} alt="" />}
        {back && <div className="jacket-shade" />}
        <div className="jacket-copy">
          {editable && <span>뒤표지</span>}
          {editable ? (
            <textarea aria-label="뒤표지 글" value={cover.backText} placeholder="뒤표지에 남길 말" onChange={(event) => updateCover({ backText: event.target.value })} />
          ) : cover.backText && <p>{cover.backText}</p>}
        </div>
        <CoverStickersLayer panel="back" stickers={stickers} editable={editable} update={updateCoverSticker} remove={removeCoverSticker} />
        <FrameLayer frame={cover.frame} variant="cover" />
      </section>
      <section
        className="jacket-panel jacket-spine"
        onDragOver={(event) => editable && event.preventDefault()}
        onDrop={(event) => {
          const id = event.dataTransfer.getData('photo/id')
          if (id) updateCover({ spinePhotoId: id })
        }}
      >
        {spine && <img src={picture(spine)} alt="" />}
        {spine && <div className="jacket-shade" />}
        {editable ? (
          <input aria-label="책등" value={cover.spineText} placeholder={cover.title || `${year}`} onChange={(event) => updateCover({ spineText: event.target.value })} />
        ) : <b>{cover.spineText || cover.title || year}</b>}
        <CoverStickersLayer panel="spine" stickers={stickers} editable={editable} update={updateCoverSticker} remove={removeCoverSticker} />
        <FrameLayer frame={cover.frame} variant="cover" />
      </section>
      <section
        className="jacket-panel jacket-front"
        onDragOver={(event) => editable && event.preventDefault()}
        onDrop={(event) => {
          const id = event.dataTransfer.getData('photo/id')
          if (id) updateCover({ frontPhotoId: id })
        }}
      >
        {front && <img src={picture(front)} alt="" />}
        {front && <div className="jacket-shade" />}
        <div className="jacket-copy">
          {editable && <span>앞표지</span>}
          {editable ? (
            <>
              <input aria-label="표지 제목" value={cover.title} placeholder={`${year}`} onChange={(event) => updateCover({ title: event.target.value })} />
              <input aria-label="표지 부제" value={cover.subtitle} placeholder="부제" onChange={(event) => updateCover({ subtitle: event.target.value })} />
            </>
          ) : (
            <>
              <h2>{cover.title || year}</h2>
              {cover.subtitle && <p>{cover.subtitle}</p>}
            </>
          )}
        </div>
        <CoverStickersLayer panel="front" stickers={stickers} editable={editable} update={updateCoverSticker} remove={removeCoverSticker} />
        <FrameLayer frame={cover.frame} variant="cover" />
      </section>
    </article>
  )
}

const NO_STROKES: { id: string; color: string; size: number; points: { x: number; y: number }[] }[] = []

function PageDrawing({ pageId, active, color, size, ratio }: {
  pageId: string
  active: boolean
  color: string
  size: number
  ratio: number
}) {
  const strokes = useBookStore((state) => state.drawings[pageId]) ?? NO_STROKES
  const addStroke = useBookStore((state) => state.addStroke)
  const [live, setLive] = useState<{ x: number; y: number }[] | null>(null)
  const vbH = 100 / Math.max(ratio, 0.01)
  const paint = live ? [...strokes, { id: 'live', color, size, points: live }] : strokes
  return (
    <div className={`page-draw-layer${active ? ' active' : ''}`}>
      <svg viewBox={`0 0 100 ${vbH}`} preserveAspectRatio="none">
        {paint.map((stroke) => (
          <polyline
            key={stroke.id}
            points={stroke.points.map((point) => `${point.x * 100},${point.y * vbH}`).join(' ')}
            fill="none"
            stroke={stroke.color}
            strokeWidth={stroke.size}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </svg>
      {active && (
        <div
          className="page-draw-capture"
          onPointerDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
            const el = event.currentTarget
            const page = el.closest<HTMLElement>('.book-page') ?? el
            const rect = page.getBoundingClientRect()
            const at = (moveEvent: PointerEvent) => ({
              x: Math.min(1, Math.max(0, (moveEvent.clientX - rect.left) / rect.width)),
              y: Math.min(1, Math.max(0, (moveEvent.clientY - rect.top) / rect.height)),
            })
            const points = [at(event.nativeEvent)]
            setLive([...points])
            el.setPointerCapture(event.pointerId)
            const move = (moveEvent: PointerEvent) => {
              points.push(at(moveEvent))
              setLive([...points])
            }
            const end = () => {
              el.removeEventListener('pointermove', move)
              el.removeEventListener('pointerup', end)
              el.removeEventListener('pointercancel', end)
              setLive(null)
              if (points.length === 1) points.push({ ...points[0] })
              addStroke(pageId, { id: `stroke-${Date.now().toString(36)}`, color, size, points: points.map((point) => ({ ...point })) })
            }
            el.addEventListener('pointermove', move)
            el.addEventListener('pointerup', end)
            el.addEventListener('pointercancel', end)
          }}
        />
      )}
    </div>
  )
}

function TemplatePreview({ layout, photos, ratio }: { layout: LayoutId; photos: Photo[]; ratio: number }) {
  const adaptive = layout === 'adaptive-flow' ? computeAdaptiveLayout(photos, ratio, true) : []
  return (
    <span className={`template-preview layout-${layout}`} style={{ '--page-ratio': ratio } as React.CSSProperties}>
      {photos.map((photo, index) => (
        <i key={photo.id} style={adaptive.length ? adaptiveMiniStyle(adaptive[index]) : undefined}>
          <img src={photo.thumbUrl || photo.url} alt="" style={photoStyle(photo)} />
        </i>
      ))}
    </span>
  )
}

function layoutLabel(layout: LayoutId) {
  return {
    'solo-bleed': '풀 블리드',
    'solo-frame': '갤러리',
    'solo-banner': '가운데 띠',
    'duo-even': '균형 분할',
    'duo-editorial': '에디토리얼',
    'duo-stack': '와이드 스택',
    'duo-sidebar': '좁은 옆면',
    'duo-banner': '하단 강조',
    'trio-hero': '세로 강조',
    'trio-hero-right': '우측 강조',
    'trio-band': '풍경 강조',
    'trio-footer': '하단 와이드',
    'trio-column': '3단 갤러리',
    'trio-rows': '가로 3단',
    'quad-grid': '클래식 그리드',
    'quad-feature': '메인 포커스',
    'quad-feature-right': '우측 메인',
    'quad-band': '상단 포커스',
    'quad-footer': '하단 포커스',
    'quad-columns': '세로 4단',
    'five-magazine': '매거진',
    'five-collage': '콜라주',
    'five-strip': '상단 와이드',
    'five-sidebar': '세로 메인',
    'five-columns': '세로 5단',
    'six-mosaic': '모자이크',
    'six-filmstrip': '필름 스트립',
    'six-grid': '2×3 그리드',
    'six-rows': '가로 3줄',
    'many-tiles': '4열 타일',
    'many-rows': '3열 타일',
    'many-portrait': '2열 타일',
    'adaptive-flow': '자유 배치',
  }[layout]
}

function photoStyle(
  photo: Photo,
  rect?: { width: number; height: number },
  pageRatio = 1,
  _preserveAspect = true,
): React.CSSProperties {
  const crop = photo.crop
  const focal = photo.analysis?.focalPoint
  const rotation = ((photo.rotation ?? 0) % 360 + 360) % 360
  const swapped = rotation === 90 || rotation === 270
  const slotRatio = rect ? (rect.width * pageRatio) / Math.max(rect.height, 0.001) : undefined
  const zoom = crop?.zoom ?? 1
  // 칸을 비율에 맞게 나눈 뒤 cover로 페이지를 빈틈없이 채움 (여백 contain 사용 안 함)
  const fillScale = swapped && slotRatio ? Math.max(slotRatio, 1 / slotRatio) : swapped ? Math.max(pageRatio, 1 / pageRatio) : 1
  const scale = fillScale * zoom
  const transforms = [
    rotation ? `rotate(${rotation}deg)` : '',
    scale !== 1 ? `scale(${scale})` : '',
  ].filter(Boolean)
  return {
    objectPosition: `${(crop?.x ?? focal?.x ?? 0.5) * 100}% ${(crop?.y ?? focal?.y ?? 0.5) * 100}%`,
    objectFit: 'cover',
    transform: transforms.length ? transforms.join(' ') : undefined,
    transformOrigin: rotation
      ? 'center center'
      : zoom > 1 && crop
        ? `${crop.x * 100}% ${crop.y * 100}%`
        : undefined,
  }
}

function rectsClose(current: Record<string, PhotoFrame>, next: Record<string, PhotoFrame>) {
  const currentIds = Object.keys(current)
  const nextIds = Object.keys(next)
  if (currentIds.length !== nextIds.length) return false
  return nextIds.every((id) => {
    const a = current[id]
    const b = next[id]
    return a && Math.abs(a.x - b.x) < 0.005 && Math.abs(a.y - b.y) < 0.005 && Math.abs(a.width - b.width) < 0.005 && Math.abs(a.height - b.height) < 0.005
  })
}

function gutterStyle(gutter: PhotoGutter): React.CSSProperties {
  if (gutter.axis === 'x') {
    return {
      left: `calc(${gutter.at * 100}% - 7px)`,
      top: `${gutter.from * 100}%`,
      width: 14,
      height: `${(gutter.to - gutter.from) * 100}%`,
    }
  }
  return {
    top: `calc(${gutter.at * 100}% - 7px)`,
    left: `${gutter.from * 100}%`,
    height: 14,
    width: `${(gutter.to - gutter.from) * 100}%`,
  }
}

function beginGutterDrag(
  event: React.PointerEvent<HTMLButtonElement>,
  gutter: PhotoGutter,
  rects: Record<string, PhotoFrame>,
  photos: Photo[],
  update: (entries: { id: string; frame: PhotoFrame }[], commit?: boolean) => void,
) {
  event.preventDefault()
  event.stopPropagation()
  const grid = event.currentTarget.closest<HTMLElement>('.photo-grid')
  if (!grid) return
  const gridRect = grid.getBoundingClientRect()
  const span = gutter.axis === 'x' ? gridRect.width : gridRect.height
  if (span < 20) return
  const startPointer = gutter.axis === 'x' ? event.clientX : event.clientY
  const startFrames = new Map(photos.flatMap((photo) => (rects[photo.id] ? [[photo.id, { ...rects[photo.id] }]] : [])))
  const locked = new Set(photos.filter((photo) => photo.layoutLocked).map((photo) => photo.id))
  const lockedFrames = photos.flatMap((photo) => (photo.layoutLocked && rects[photo.id] ? [rects[photo.id]] : []))
  let latest: { id: string; frame: PhotoFrame }[] = []
  const framesAt = (at: number) => photos.flatMap((photo) => {
    if (photo.layoutLocked) return []
    const frame = startFrames.get(photo.id)
    if (!frame) return []
    if (gutter.axis === 'x' && gutter.before.includes(photo.id)) {
      return [{ id: photo.id, frame: { ...frame, width: Math.max(0.12, at - frame.x) } }]
    }
    if (gutter.axis === 'x' && gutter.after.includes(photo.id)) {
      const right = frame.x + frame.width
      return [{ id: photo.id, frame: { ...frame, x: at, width: Math.max(0.12, right - at) } }]
    }
    if (gutter.axis === 'y' && gutter.before.includes(photo.id)) {
      return [{ id: photo.id, frame: { ...frame, height: Math.max(0.12, at - frame.y) } }]
    }
    if (gutter.axis === 'y' && gutter.after.includes(photo.id)) {
      const bottom = frame.y + frame.height
      return [{ id: photo.id, frame: { ...frame, y: at, height: Math.max(0.12, bottom - at) } }]
    }
    return [{ id: photo.id, frame }]
  })
  const move = (moveEvent: PointerEvent) => {
    const point = gutter.axis === 'x' ? moveEvent.clientX : moveEvent.clientY
    let at = gutter.at + (point - startPointer) / span
    for (const id of gutter.before) {
      if (locked.has(id)) continue
      const frame = startFrames.get(id)
      if (!frame) continue
      at = Math.max(at, (gutter.axis === 'x' ? frame.x : frame.y) + 0.12)
    }
    for (const id of gutter.after) {
      if (locked.has(id)) continue
      const frame = startFrames.get(id)
      if (!frame) continue
      const edge = gutter.axis === 'x' ? frame.x + frame.width : frame.y + frame.height
      at = Math.min(at, edge - 0.12)
    }
    for (const obstacle of lockedFrames) {
      const spanStart = gutter.axis === 'x' ? obstacle.y : obstacle.x
      const spanEnd = gutter.axis === 'x' ? obstacle.y + obstacle.height : obstacle.x + obstacle.width
      if (gutter.from >= spanEnd - 0.02 || gutter.to <= spanStart + 0.02) continue
      const edgeStart = gutter.axis === 'x' ? obstacle.x : obstacle.y
      const edgeEnd = gutter.axis === 'x' ? obstacle.x + obstacle.width : obstacle.y + obstacle.height
      if (gutter.at <= edgeStart + 0.001) at = Math.min(at, edgeStart)
      else if (gutter.at >= edgeEnd - 0.001) at = Math.max(at, edgeEnd)
      else if (at > edgeStart && at < edgeEnd) at = gutter.at < (edgeStart + edgeEnd) / 2 ? Math.min(at, edgeStart) : Math.max(at, edgeEnd)
    }
    at = Math.max(0, Math.min(1, at))
    latest = framesAt(at)
    update(latest, false)
  }
  const finish = () => {
    document.removeEventListener('pointermove', move)
    document.removeEventListener('pointerup', finish)
    document.removeEventListener('pointercancel', finish)
    if (latest.length) update(latest, true)
  }
  document.addEventListener('pointermove', move)
  document.addEventListener('pointerup', finish)
  document.addEventListener('pointercancel', finish)
}

function beginResize(
  event: React.PointerEvent<HTMLButtonElement>,
  photo: Photo,
  updatePhotoFrame: (id: string, frame: PhotoFrame, commit?: boolean, bringToFront?: boolean) => void,
) {
  event.preventDefault()
  event.stopPropagation()
  const handle = event.currentTarget
  const cell = handle.closest<HTMLElement>('.photo-cell')
  const grid = handle.closest<HTMLElement>('.photo-grid')
  if (!cell || !grid) return
  const startFrame = frameFromElements(cell, grid)
  const gridRect = grid.getBoundingClientRect()
  const pointerId = event.pointerId
  const startX = event.clientX
  const startY = event.clientY
  let nextFrame = startFrame
  let resizing = false
  handle.setPointerCapture(pointerId)
  const move = (moveEvent: PointerEvent) => {
    nextFrame = {
      ...startFrame,
      width: Math.max(0.12, Math.min(1 - startFrame.x, startFrame.width + (moveEvent.clientX - startX) / gridRect.width)),
      height: Math.max(0.12, Math.min(1 - startFrame.y, startFrame.height + (moveEvent.clientY - startY) / gridRect.height)),
    }
    updatePhotoFrame(photo.id, nextFrame, false, !resizing)
    resizing = true
    handle.dataset.resizing = 'true'
    handle.dataset.previewWeight = `${Math.round(nextFrame.width * 100)} × ${Math.round(nextFrame.height * 100)}`
  }
  const finish = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', finish)
    handle.removeEventListener('pointercancel', finish)
    delete handle.dataset.resizing
    delete handle.dataset.previewWeight
    if (resizing) updatePhotoFrame(photo.id, nextFrame, true)
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', finish)
  handle.addEventListener('pointercancel', finish)
}

function beginMove(
  event: React.PointerEvent<HTMLDivElement>,
  photo: Photo,
  updatePhotoFrame: (id: string, frame: PhotoFrame, commit?: boolean, bringToFront?: boolean) => void,
) {
  if ((event.target as HTMLElement).closest('button')) return
  const cell = event.currentTarget
  const grid = cell.closest<HTMLElement>('.photo-grid')
  if (!grid) return
  const gridRect = grid.getBoundingClientRect()
  const startFrame = frameFromElements(cell, grid)
  const startX = event.clientX
  const startY = event.clientY
  let nextFrame = startFrame
  let moving = false
  const move = (moveEvent: PointerEvent) => {
    const dx = (moveEvent.clientX - startX) / gridRect.width
    const dy = (moveEvent.clientY - startY) / gridRect.height
    if (!moving && Math.hypot(dx * gridRect.width, dy * gridRect.height) < 3) return
    if (!moving) cell.setPointerCapture(moveEvent.pointerId)
    nextFrame = {
      ...startFrame,
      x: Math.max(0, Math.min(1 - startFrame.width, startFrame.x + dx)),
      y: Math.max(0, Math.min(1 - startFrame.height, startFrame.y + dy)),
    }
    updatePhotoFrame(photo.id, nextFrame, false, !moving)
    moving = true
  }
  const finish = () => {
    cell.removeEventListener('pointermove', move)
    cell.removeEventListener('pointerup', finish)
    cell.removeEventListener('pointercancel', finish)
    if (moving) updatePhotoFrame(photo.id, nextFrame, true)
  }
  cell.addEventListener('pointermove', move)
  cell.addEventListener('pointerup', finish)
  cell.addEventListener('pointercancel', finish)
}

function beginInlineCrop(
  event: React.PointerEvent<HTMLDivElement>,
  photo: Photo,
  setPhotoCrop: (id: string, crop: NonNullable<Photo['crop']>) => void,
) {
  if ((event.target as HTMLElement).closest('.inline-crop-controls')) return
  event.preventDefault()
  event.stopPropagation()
  const cell = event.currentTarget
  const rect = cell.getBoundingClientRect()
  const startX = event.clientX
  const startY = event.clientY
  const initial = photo.crop ?? {
    zoom: 1,
    x: photo.analysis?.focalPoint.x ?? 0.5,
    y: photo.analysis?.focalPoint.y ?? 0.5,
  }
  cell.setPointerCapture(event.pointerId)
  const move = (moveEvent: PointerEvent) => {
    setPhotoCrop(photo.id, {
      ...initial,
      x: Math.max(0, Math.min(1, initial.x - (moveEvent.clientX - startX) / rect.width / initial.zoom)),
      y: Math.max(0, Math.min(1, initial.y - (moveEvent.clientY - startY) / rect.height / initial.zoom)),
    })
  }
  const finish = () => {
    cell.removeEventListener('pointermove', move)
    cell.removeEventListener('pointerup', finish)
    cell.removeEventListener('pointercancel', finish)
  }
  cell.addEventListener('pointermove', move)
  cell.addEventListener('pointerup', finish)
  cell.addEventListener('pointercancel', finish)
}

function frameFromElements(cell: HTMLElement, grid: HTMLElement): PhotoFrame {
  const cellRect = cell.getBoundingClientRect()
  const gridRect = grid.getBoundingClientRect()
  return {
    x: Math.max(0, (cellRect.left - gridRect.left) / gridRect.width),
    y: Math.max(0, (cellRect.top - gridRect.top) / gridRect.height),
    width: Math.min(1, cellRect.width / gridRect.width),
    height: Math.min(1, cellRect.height / gridRect.height),
  }
}

function adaptiveCellStyle(
  rect?: { x: number; y: number; width: number; height: number },
  isAnchor = false,
): React.CSSProperties {
  if (!rect) return {}
  return {
    left: `calc(${rect.x * 100}% + 4px)`,
    top: `calc(${rect.y * 100}% + 4px)`,
    width: `calc(${rect.width * 100}% - 8px)`,
    height: `calc(${rect.height * 100}% - 8px)`,
    zIndex: isAnchor ? 3 : 1,
  }
}

function adaptiveMiniStyle(
  rect?: { x: number; y: number; width: number; height: number },
  isAnchor = false,
): React.CSSProperties {
  if (!rect) return {}
  return {
    position: 'absolute',
    left: `calc(${rect.x * 100}% + 1px)`,
    top: `calc(${rect.y * 100}% + 1px)`,
    width: `calc(${rect.width * 100}% - 2px)`,
    height: `calc(${rect.height * 100}% - 2px)`,
    zIndex: isAnchor ? 2 : 1,
  }
}

function photoHoldLabel(excludeReason?: ExcludeReason, holdReason?: HoldReason) {
  if (excludeReason === 'blur') return '흐림'
  if (excludeReason === 'screenshot') return '스크린샷'
  if (excludeReason === 'document') return '문서'
  if (excludeReason === 'duplicate') return '중복'
  if (excludeReason === 'lowres') return '낮은 해상도'
  if (holdReason === 'budget') return '페이지 한도'
  if (holdReason === 'date') return '숨긴 날짜'
  if (holdReason === 'face') return '숨긴 얼굴'
  if (holdReason === 'people') return '선택 인물'
  return ''
}

function sceneLabel(scene: NonNullable<Photo['analysis']>['scene']) {
  return {
    people: '인물',
    landscape: '풍경',
    food: '음식',
    animal: '동물',
    architecture: '건축',
    other: '장면',
  }[scene]
}

export default App
