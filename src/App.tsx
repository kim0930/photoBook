import {
  BookOpen, ChevronLeft, ChevronRight, ChevronsLeft, Download, FolderOpen, Home, ImagePlus, Pencil,
  Crop, Grip, LayoutTemplate, Lock, MapPinned, Maximize2, Minus, Mountain, Plus, RotateCcw, RotateCw, Settings2, Sparkles,
  Trash2, Upload, Users, WandSparkles, X,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import 'leaflet/dist/leaflet.css'
import './App.css'
import { buildChapters, cachedPlace, placeName } from './chapters/tripDetection'
import { analyzePhoto } from './classify/analyzePhoto'
import { LivePhotoPicker } from './components/LivePhotoPicker'
import { MemoriesPanel } from './components/MemoriesPanel'
import { TripMap } from './components/TripMap'
import { groupFaces } from './curate/faces'
import { scanDocuments } from './curate/ocr'
import { SIGNALS_VERSION, curatePhotos, scoreQuality } from './curate/signals'
import { loadCover, loadCurationSettings, loadDrawings, loadFaceGroups, loadLibrary, loadPageCaptions, loadPageNotes, saveCurationSettings, savePageNotes } from './db'
import { exportBookPdf, preparePrintUrls, revokePrintUrls, waitForExportImages } from './export/pdf'
import { chooseDirectoryFiles, scanFiles } from './import/scanFolder'
import { availableLayouts, computeAdaptiveLayout, findPhotoGutters, type LayoutId, type PhotoGutter } from './layout/autoLayout'
import { BOOK_SIZES, MAX_PAGES, coverSpread } from './settings/bookSize'
import { useBookStore } from './store'
import type { BookPage, Chapter, ExcludeReason, HoldReason, ImportProgress, PageCaption, PageNote, Photo, PhotoFrame } from './types'

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
const EARLIEST_YEAR = 1970
const YEAR_OPTIONS = Array.from({ length: CURRENT_YEAR - EARLIEST_YEAR + 1 }, (_, index) => CURRENT_YEAR - index)

function App() {
  const store = useBookStore()
  const setLibrary = useBookStore((state) => state.setLibrary)
  const [year, setYear] = useState(CURRENT_YEAR)
  const [progress, setProgress] = useState<ImportProgress>()
  const [importError, setImportError] = useState('')
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
  const [showWelcome, setShowWelcome] = useState(false)
  const [thumbSize, setThumbSize] = useState(() => storedNumber('photobook-thumb-size', DEFAULT_THUMB))
  const [templateSize, setTemplateSize] = useState(() => {
    const stored = storedNumber('photobook-template-size', DEFAULT_TEMPLATE)
    return TEMPLATE_SIZES.includes(stored) ? stored : DEFAULT_TEMPLATE
  })
  const [trayWidth, setTrayWidth] = useState(() => storedNumber('photobook-tray-width', trayWidthForColumns(DEFAULT_THUMB)))
  const [coverMode, setCoverMode] = useState(false)
  const [drawMode, setDrawMode] = useState(false)
  const [penColor, setPenColor] = useState('#2b2824')
  const [penSize, setPenSize] = useState(1.2)
  const canvasRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const addInputRef = useRef<HTMLInputElement>(null)
  const trayListRef = useRef<HTMLDivElement>(null)
  const pageListRef = useRef<HTMLDivElement>(null)

  const selectedIndex = Math.max(0, store.pages.findIndex((page) => page.id === store.selectedPageId))
  const selectedPage = store.pages[selectedIndex]
  const selectedChapter = store.chapters.find((chapter) => chapter.id === selectedPage?.chapterId)
  const pagePlacements = pagePlacementByPhoto(store.pages)

  useEffect(() => {
    let active = true
    void Promise.all([loadLibrary(), loadPageNotes(), loadDrawings(), loadCover(), loadPageCaptions(), loadCurationSettings(), loadFaceGroups()])
      .then(async ([library, pageNotes, drawings, cover, pageCaptions, curation, faceGroups]) => {
        if (!active) return
        const memos = Object.fromEntries(Object.entries(pageNotes).map(([pageId, notes]) => {
          const kept = notes.filter((note) => note.kind === 'memo')
          if (kept.length !== notes.length) void savePageNotes(pageId, kept)
          return [pageId, kept]
        }))
        let photos = library.photos
        let nextCuration = curation
        if (photos.length && (curation.signalsVersion ?? 0) < SIGNALS_VERSION) {
          photos = await curatePhotos(photos)
          if (!active) return
          nextCuration = { ...curation, signalsVersion: SIGNALS_VERSION }
          await saveCurationSettings(nextCuration)
        }
        useBookStore.setState({ pageNotes: memos, drawings, pageCaptions, curation: nextCuration, faceGroups, ...(cover ? { cover } : {}) })
        if (photos.length && library.chapters.length) setLibrary(photos, library.chapters)
      })
      .finally(() => active && setRestoring(false))
    return () => {
      active = false
    }
  }, [setLibrary])

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
    try {
      const scanned = await scanFiles(files, year, setProgress)
      if (!scanned.length) throw new Error(`${year}년에 촬영한 사진을 찾지 못했습니다.`)
      const existing = replace ? [] : useBookStore.getState().photos
      const curated = await curatePhotos([...existing, ...scanned], (current, total) => {
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
    } catch (error) {
      setImportError(error instanceof Error ? error.message : '사진을 가져오지 못했습니다.')
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

  async function exportPdf() {
    const urls = new Map<string, string>()
    try {
      const prepared = await preparePrintUrls(useBookStore.getState().photos, setExportLabel)
      prepared.forEach((url, id) => urls.set(id, url))
      flushSync(() => {
        setPrintUrls(Object.fromEntries(urls))
        setExportLabel('PDF 만드는 중')
      })
      await waitForExportImages()
      const { bookSize, orientation, pages } = useBookStore.getState()
      await exportBookPdf(bookSize, orientation, pages.length, (page) => setExportLabel(`${page}/${pages.length}`))
    } catch (error) {
      console.warn('PDF 내보내기에 실패했습니다.', error)
    } finally {
      revokePrintUrls(urls.values())
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
      await importFiles(files)
    } catch (error) {
      setProgress(undefined)
      if (error instanceof Error && error.message === 'FALLBACK_INPUT') inputRef.current?.click()
      else if (error instanceof DOMException && error.name === 'AbortError') return
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
      if (target.closest('.inline-crop-controls, .photo-actions, .swap-photo, .resize-handle, .chapter-toolbar')) return
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

  if (!store.photos.length || showWelcome) {
    return (
      <main className="welcome">
        <nav className="brand"><BookOpen /><span>Year in Frames</span></nav>
        <section className="welcome-content">
          <span className="eyebrow"><Sparkles size={14} /> 나만의 한 해</span>
          <h1>사진은 그대로.<br /><em>추억은 한 권으로.</em></h1>
          <p className="lead">아이폰의 올해 사진을 불러오면 월별 기록과 여행을 찾아<br />아름다운 포토북 초안을 자동으로 만듭니다.</p>
          <div className="import-card">
            <div className="year-row">
              <label htmlFor="year">포토북 연도</label>
              <select id="year" value={year} onChange={(event) => setYear(Number(event.target.value))}>
                {YEAR_OPTIONS.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
            </div>
            <button className="import-button" onClick={pickFolder} disabled={Boolean(progress)}>
              <FolderOpen /> 아이폰 사진 폴더 선택
            </button>
            {store.photos.length > 0 && (
              <button className="secondary-button continue-button" onClick={() => setShowWelcome(false)}>
                기존 포토북 편집 계속
              </button>
            )}
            <button className="text-button" onClick={() => inputRef.current?.click()}>파일 또는 폴더 직접 선택</button>
            <input
              ref={inputRef}
              className="hidden-input"
              type="file"
              multiple
              accept="image/*,.heic,.heif,.mov,video/quicktime"
              {...({ webkitdirectory: '' } as React.InputHTMLAttributes<HTMLInputElement>)}
              onChange={(event) => void importFiles(Array.from(event.target.files ?? []))}
            />
            {progress && (
              <div className="progress">
                <div><span style={{ width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 100}%` }} /></div>
                <small>{progress.total > 0 ? `${progress.label} · ${progress.current}/${progress.total}` : progress.label}</small>
              </div>
            )}
            {importError && <p className="error">{importError}</p>}
          </div>
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
        if (event.key === 'Delete' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
          const focused = document.querySelector<HTMLElement>('.photo-cell:focus')
          if (focused?.dataset.photoId) store.unplacePhoto(focused.dataset.photoId)
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') store.undo()
      }}
    >
      <header className="topbar">
        <div className="brand"><BookOpen /><span>Year in Frames</span><i>{year}</i></div>
        <button className="top-add-photo" onClick={() => addInputRef.current?.click()}><ImagePlus /> 사진 추가</button>
        <input ref={addInputRef} className="hidden-input" type="file" multiple accept="image/*,.heic,.heif" onChange={(e) => void importFiles(Array.from(e.target.files ?? []), false)} />
        <div className="top-actions">
          <button className="ghost-button" onClick={() => setShowWelcome(true)}><Home /> 첫 화면</button>
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
            <span>표지</span>
            <MiniJacket />
          </button>
          {store.pages.map((page, index) => {
            const chapter = store.chapters.find((item) => item.id === page.chapterId)
            const heading = store.pages[index - 1]?.chapterId === page.chapterId ? undefined : chapterHeading(chapter)
            const caption = pageCaption(chapter, store.pageNotes[page.id] ?? [])
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
                <div className="page-thumb-wrap">
                <button
                  className={`page-thumb ${!coverMode && page.id === selectedPage?.id ? 'active' : ''}`}
                  onClick={() => { setCoverMode(false); store.selectPage(page.id) }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    const photoId = event.dataTransfer.getData('photo/id')
                    if (photoId) store.movePhoto(photoId, page.id)
                  }}
                >
                  <span>{index + 1}</span>
                  <MiniPage page={page} chapter={chapter} notes={store.pageNotes[page.id] ?? []} />
                  {caption && <em className="page-thumb-caption">{caption}</em>}
                </button>
                <button type="button" className="page-delete" aria-label="페이지 삭제" title="이 페이지를 책에서 빼기" onClick={() => store.removePage(page.id)}><Trash2 /></button>
                </div>
              </div>
            )
          })}
        </div>
        </>
        )}
      </aside>

      <main className="workspace">
        {(coverMode || selectedPage) && (
          <>
            <div className="chapter-toolbar">
              {coverMode ? (
                <CoverBar />
              ) : (
                <>
                  <div>
                    <span>{selectedChapter?.type === 'trip' ? '여행 챕터' : `${selectedChapter?.month}월 챕터`}</span>
                    <input
                      value={selectedChapter?.title ?? ''}
                      aria-label="챕터 제목"
                      placeholder="챕터 이름"
                      onChange={(event) => selectedChapter && store.updateChapter(selectedChapter.id, { title: event.target.value })}
                    />
                  </div>
                  <div className="note-toolbar">
                    <button type="button" onClick={() => store.addPageNote(selectedPage.id)}>메모</button>
                    <button type="button" className={drawMode ? 'active' : ''} onClick={() => setDrawMode((on) => !on)}><Pencil /> 그리기</button>
                  </div>
                  {drawMode && (
                    <div className="draw-tools">
                      <label className="note-swatch">색<input type="color" aria-label="펜 색" value={penColor} onChange={(event) => setPenColor(event.target.value)} /></label>
                      <label className="note-opacity">굵기<input type="range" min={0.4} max={2.4} step={0.1} aria-label="펜 굵기" value={penSize} onChange={(event) => setPenSize(Number(event.target.value))} /></label>
                      <button type="button" onClick={() => store.undoStroke(selectedPage.id)}>한 획 취소</button>
                      <button type="button" onClick={() => store.clearStrokes(selectedPage.id)}>모두 지우기</button>
                    </div>
                  )}
                  <span>페이지 {selectedIndex + 1}</span>
                  <button type="button" onClick={() => selectedPage && store.removePage(selectedPage.id)}>페이지 삭제</button>
                </>
              )}
            </div>
            <div className="canvas-area" ref={canvasRef}>
              {!coverMode && <button className="page-arrow" disabled={selectedIndex === 0} onClick={() => store.selectPage(store.pages[selectedIndex - 1].id)}><ChevronLeft /></button>}
              {coverMode ? <BookJacket year={year} editable /> : (
                <PagePaper
                  page={selectedPage}
                  chapter={selectedChapter}
                  editable
                  drawing={drawMode}
                  penColor={penColor}
                  penSize={penSize}
                  onOpenLive={setLivePhoto}
                  croppingPhotoId={cropPhotoId}
                  selectedPhotoId={selectedCanvasPhotoId}
                  onSelectPhoto={setSelectedCanvasPhotoId}
                  onCrop={openCrop}
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
              <button className={(selectedPage?.flowAspect ?? 'locked') === 'locked' ? 'active' : ''} onClick={() => selectedPage && store.setPageFlowAspect(selectedPage.id, 'locked')}>비율 유지</button>
              <button className={selectedPage?.flowAspect === 'free' ? 'active' : ''} onClick={() => selectedPage && store.setPageFlowAspect(selectedPage.id, 'free')}>자유 채우기</button>
            </div>
          </div>
          {selectedPage?.type === 'photos' ? (
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
        <section className="photo-library">
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
          <div className="photo-tray-list" ref={trayListRef}>
            {libraryEntries(store.photos, year).map((entry) => {
              if (entry.type === 'month') return <div key={entry.key} className="tray-month">{entry.label}</div>
              if (entry.type === 'day') return <div key={entry.key} className="tray-day">{entry.label}</div>
              const photo = entry.photo
              const placement = pagePlacements.get(photo.id)
              const onCanvas = selectedPage?.photoIds.includes(photo.id)
              return (
                <button
                  key={photo.id}
                  className={`tray-photo${placement ? ' placed' : ''}${onCanvas ? ' on-canvas' : ''}`}
                  data-photo-id={photo.id}
                  draggable
                  onDragStart={(event) => event.dataTransfer.setData('photo/id', photo.id)}
                  onClick={() => placement && store.selectPage(placement.pageId)}
                  onDoubleClick={() => openCrop(photo)}
                  title={[
                    photo.name,
                    photoHoldLabel(photo.excludeReason, photo.holdReason),
                    placement ? `${placement.number}페이지로 이동` : '페이지로 드래그',
                  ].filter(Boolean).join(' · ')}
                >
                  <img src={photo.thumbUrl} alt={photo.name} style={photoStyle(photo)} />
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
              )
            })}
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
          {store.curation.faceGroupsEnabled && store.faceGroups.map((group) => {
            const cover = store.photos.find((photo) => photo.id === (group.coverPhotoId ?? group.photoIds[0]))
            return (
              <div key={group.id} className="face-row">
                {cover && <img src={cover.thumbUrl} alt="" />}
                <input
                  aria-label="사람 이름"
                  value={group.name}
                  placeholder="이름"
                  onChange={(event) => store.renameFaceGroup(group.id, event.target.value)}
                />
                <button type="button" onClick={() => store.setFaceGroupHidden(group.id, !group.hidden)}>{group.hidden ? '표시' : '숨기기'}</button>
              </div>
            )
          })}
        </div>
      )}

      {livePhoto && <LivePhotoPicker photo={livePhoto} onClose={() => setLivePhoto(undefined)} onSelect={(data) => store.setSelectedFrame(livePhoto.id, data)} />}
      <div className="export-stage" aria-hidden>
        <BookJacket year={year} printUrls={printUrls} printing />
        {store.pages.map((page, index) => (
          <PagePaper key={page.id} page={page} chapter={store.chapters.find((chapter) => chapter.id === page.chapterId)} exportIndex={index} printUrls={printUrls} pageNumber={index + 1} placeRevision={placeRevision} />
        ))}
      </div>
    </div>
  )
}

function MiniPage({ page, chapter, notes = [] }: { page: BookPage; chapter?: Chapter; notes?: PageNote[] }) {
  const { photos, bookSize, orientation } = useBookStore()
  const items = page.photoIds.map((id) => photos.find((photo) => photo.id === id)).filter(Boolean) as Photo[]
  const ratio = orientation === 'portrait' ? bookSize.widthMm / bookSize.heightMm : bookSize.heightMm / bookSize.widthMm
  const preserveFlowAspect = (page.flowAspect ?? 'locked') === 'locked'
  const rects = page.layoutId === 'adaptive-flow' ? computeAdaptiveLayout(items, ratio, preserveFlowAspect) : []
  const activeAnchorId = [...items]
    .filter((photo) => photo.freeFrame)
    .sort((a, b) => (b.framePriority ?? 0) - (a.framePriority ?? 0))[0]?.id
  const monthLabel = chapter?.type === 'trip' ? '여행' : chapter?.month ? `${chapter.month}월` : ''
  return (
    <div className={`mini-paper type-${page.type} layout-${page.layoutId ?? ''}`} style={{ '--page-ratio': ratio } as React.CSSProperties}>
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
      {page.type === 'intro' && (
        <div className="mini-copy">
          <span>{chapter?.type === 'trip' ? 'JOURNEY' : monthLabel}</span>
          <b>{chapter?.title}</b>
          {chapter?.note && <em>{chapter.note}</em>}
        </div>
      )}
      {page.type !== 'intro' && monthLabel && <span className="mini-month">{monthLabel}</span>}
      {notes.filter((note) => note.kind === 'memo').map((note) => (
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

function pageCaption(chapter: Chapter | undefined, notes: PageNote[]) {
  const month = chapter?.type === 'trip' ? (chapter.title || '여행') : chapter?.month ? `${chapter.month}월` : ''
  const title = chapter?.type === 'month' && chapter.title && chapter.title !== `${chapter.month}월` ? chapter.title : ''
  const phrases = notes.map((note) => note.text.trim()).filter(Boolean)
  return [month, title, chapter?.note, ...phrases].filter(Boolean).join(' · ')
}

function chapterHeading(chapter?: Chapter) {
  if (!chapter) return { label: '챕터', title: '' }
  const label = chapter.type === 'trip' ? '여행 챕터' : `${chapter.month}월 챕터`
  const sameAsLabel = chapter.title === label || chapter.title === `${chapter.month}월`
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

function libraryEntries(photos: Photo[], year: number) {
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
      const month = `${date.getMonth() + 1}월`
      entries.push({
        type: 'month',
        key: nextMonth,
        label: date.getFullYear() === year ? month : `${date.getFullYear()}년 ${month}`,
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
  const { photos, updateChapter, updatePhotoFrame, updatePhotoFrames, setLayoutLock, setPhotoCrop, rotatePhoto, addPhotoToPage, unplacePhoto, swapPhotoPositions, bookSize, orientation, marginMm, pageNotes, updatePageNote, removePageNote, pageCaptions, updatePageCaption } = useBookStore()
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
        <PageDrawing pageId={page.id} active={Boolean(editable && drawing)} color={penColor} size={penSize} ratio={ratio} />
        <PageFooter pageId={page.id} photos={chapterPhotos.length ? chapterPhotos : items} chapter={chapter} pageNumber={pageNumber} placeRevision={placeRevision} editable={editable} caption={pageCaptions[page.id]} updatePageCaption={updatePageCaption} />
      </article>
    )
  }
  if (page.type === 'map') {
    return (
      <article className="book-page map-page" style={style} data-export-page={exportIndex}>
        <div className="map-title"><span>OUR ROUTE</span><ChapterTitle chapter={chapter} editable={editable} updateChapter={updateChapter} /></div>
        <TripMap photos={chapterPhotos} />
        <PageNotes pageId={page.id} notes={pageNotes[page.id] ?? []} editable={editable} updatePageNote={updatePageNote} removePageNote={removePageNote} />
        <PageDrawing pageId={page.id} active={Boolean(editable && drawing)} color={penColor} size={penSize} ratio={ratio} />
        <PageFooter pageId={page.id} photos={chapterPhotos} chapter={chapter} pageNumber={pageNumber} placeRevision={placeRevision} editable={editable} caption={pageCaptions[page.id]} updatePageCaption={updatePageCaption} />
      </article>
    )
  }
  return (
    <article
      className="book-page photo-page"
      style={style}
      data-export-page={exportIndex}
      onDragOver={(event) => editable && event.preventDefault()}
      onDrop={(event) => {
        if (!editable) return
        const id = event.dataTransfer.getData('photo/id')
        if (id) addPhotoToPage(id, page.id)
      }}
    >
      <ChapterTitle chapter={chapter} editable={editable} updateChapter={updateChapter} />
      <div className={`photo-grid layout-${page.layoutId ?? 'many-tiles'}`} ref={gridRef}>
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
              if ((event.target as HTMLElement).closest('button')) return
              event.preventDefault()
              onCrop?.(photo)
            }}
            onPointerDown={(event) => {
              if (!editable || drawing) return
              if ((event.target as HTMLElement).closest('button')) return
              if (event.detail > 1) {
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
              const sourceId = event.dataTransfer.getData('photo/id')
              if (sourceId) addPhotoToPage(sourceId, page.id)
            }}
          >
            <img
              src={imageSrc(photo, exportIndex, printUrls)}
              alt={photo.name}
              draggable={false}
              style={photoStyle(photo, adaptiveRects[index], ratio, preserveFlowAspect)}
            />
            {editable && photo.analysis && (
              <span className={`scene-badge scene-${photo.analysis.scene}`}>
                {photo.analysis.scene === 'people' ? <Users /> : photo.analysis.scene === 'landscape' ? <Mountain /> : <LayoutTemplate />}
                {sceneLabel(photo.analysis.scene)}
              </span>
            )}
            {editable && (
              <div className="photo-actions">
                {photo.isLive && <button onClick={() => onOpenLive?.(photo)} title="실시간 사진 장면 선택">LIVE</button>}
                <button
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
                <button onClick={() => onCrop?.(photo)} title="사진 자르기"><Crop /></button>
                <button
                  type="button"
                  title="시계 방향으로 90도 회전"
                  aria-label="사진 회전"
                  onClick={() => rotatePhoto(photo.id)}
                >
                  <RotateCw />
                </button>
                {chapter?.type === 'month' && <button onClick={() => updateChapter(chapter.id, { coverPhotoId: photo.id })} title="이달의 대표 사진">대표</button>}
                <button className="delete-action" onClick={() => unplacePhoto(photo.id)} title="페이지에서 빼기"><Trash2 /></button>
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
      <PageDrawing pageId={page.id} active={Boolean(editable && drawing)} color={penColor} size={penSize} ratio={ratio} />
      <PageFooter pageId={page.id} photos={items} chapter={chapter} pageNumber={pageNumber} placeRevision={placeRevision} editable={editable} caption={pageCaptions[page.id]} updatePageCaption={updatePageCaption} />
    </article>
  )
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

function MiniJacket() {
  const cover = useBookStore((state) => state.cover)
  return (
    <span className="mini-jacket" style={{ background: cover.backgroundColor, color: cover.textColor }}>
      <em>{cover.backText || '뒤'}</em>
      <i />
      <b>{cover.title || '앞'}</b>
    </span>
  )
}

function CoverBar() {
  const { photos, cover, updateCover } = useBookStore()
  return (
    <div className="cover-fields">
      <label>앞표지
        <select aria-label="앞표지 사진" value={cover.frontPhotoId ?? ''} onChange={(event) => updateCover({ frontPhotoId: event.target.value || undefined })}>
          <option value="">사진 없음</option>
          {photos.map((photo) => <option key={photo.id} value={photo.id}>{photo.name}</option>)}
        </select>
      </label>
      <label>뒤표지
        <select aria-label="뒤표지 사진" value={cover.backPhotoId ?? ''} onChange={(event) => updateCover({ backPhotoId: event.target.value || undefined })}>
          <option value="">사진 없음</option>
          {photos.map((photo) => <option key={photo.id} value={photo.id}>{photo.name}</option>)}
        </select>
      </label>
      <label className="note-swatch">배경<input type="color" aria-label="표지 배경" value={cover.backgroundColor} onChange={(event) => updateCover({ backgroundColor: event.target.value })} /></label>
      <label className="note-swatch">글자<input type="color" aria-label="표지 글자" value={cover.textColor} onChange={(event) => updateCover({ textColor: event.target.value })} /></label>
    </div>
  )
}

function BookJacket({ year, editable = false, printUrls, printing = false }: {
  year: number
  editable?: boolean
  printUrls?: Record<string, string>
  printing?: boolean
}) {
  const { cover, updateCover, photos, pages, bookSize, orientation } = useBookStore()
  const spread = coverSpread(bookSize, orientation, Math.max(pages.length, 1))
  const front = photos.find((photo) => photo.id === cover.frontPhotoId)
  const back = photos.find((photo) => photo.id === cover.backPhotoId)
  const picture = (photo?: Photo) => photo && (printing && printUrls?.[photo.id] ? printUrls[photo.id] : (photo.thumbUrl || photo.url))
  const style = {
    '--page-ratio': spread.widthMm / spread.heightMm,
    '--jacket-ratio': spread.spreadMm / spread.heightMm,
    background: cover.backgroundColor,
    color: cover.textColor,
    gridTemplateColumns: `${spread.widthMm}fr ${spread.spineMm}fr ${spread.widthMm}fr`,
  } as React.CSSProperties
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
      </section>
      <section className="jacket-panel jacket-spine">
        {editable ? (
          <input aria-label="책등" value={cover.spineText} placeholder={cover.title || `${year}`} onChange={(event) => updateCover({ spineText: event.target.value })} />
        ) : <b>{cover.spineText || cover.title || year}</b>}
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
  preserveAspect = true,
): React.CSSProperties {
  const crop = photo.crop
  const focal = photo.analysis?.focalPoint
  const rotation = ((photo.rotation ?? 0) % 360 + 360) % 360
  const swapped = rotation === 90 || rotation === 270
  const slotRatio = rect ? (rect.width * pageRatio) / Math.max(rect.height, 0.001) : undefined
  const photoRatio = swapped ? photo.height / photo.width : photo.width / photo.height
  const cropAmount = slotRatio ? 1 - Math.min(slotRatio / photoRatio, photoRatio / slotRatio) : 0
  const fitContain = preserveAspect && cropAmount > 0.15
  const zoom = crop?.zoom ?? 1
  const fillScale = swapped && slotRatio ? Math.max(slotRatio, 1 / slotRatio) : swapped ? Math.max(pageRatio, 1 / pageRatio) : 1
  const scale = fillScale * zoom
  const transforms = [
    rotation ? `rotate(${rotation}deg)` : '',
    scale !== 1 ? `scale(${scale})` : '',
  ].filter(Boolean)
  return {
    objectPosition: `${(crop?.x ?? focal?.x ?? 0.5) * 100}% ${(crop?.y ?? focal?.y ?? 0.5) * 100}%`,
    objectFit: fitContain ? 'contain' : 'cover',
    background: fitContain ? '#eee8de' : undefined,
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
