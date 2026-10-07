import {
  BookOpen, ChevronLeft, ChevronRight, ChevronsLeft, Download, FolderOpen, Home, ImagePlus,
  Crop, Grip, LayoutTemplate, MapPinned, Maximize2, Mountain, RotateCcw, Settings2, Sparkles,
  Trash2, Upload, Users, WandSparkles, X,
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import 'leaflet/dist/leaflet.css'
import './App.css'
import { buildChapters } from './chapters/tripDetection'
import { analyzePhoto } from './classify/analyzePhoto'
import { LivePhotoPicker } from './components/LivePhotoPicker'
import { TripMap } from './components/TripMap'
import { loadLibrary } from './db'
import { exportBookPdf } from './export/pdf'
import { chooseDirectoryFiles, scanFiles } from './import/scanFolder'
import { availableLayouts, computeAdaptiveLayout, type LayoutId } from './layout/autoLayout'
import { BOOK_SIZES, MAX_PAGES } from './settings/bookSize'
import { useBookStore } from './store'
import type { BookPage, Chapter, ImportProgress, Photo, PhotoFrame } from './types'

const CURRENT_YEAR = new Date().getFullYear()

function App() {
  const store = useBookStore()
  const setLibrary = useBookStore((state) => state.setLibrary)
  const [year, setYear] = useState(CURRENT_YEAR)
  const [progress, setProgress] = useState<ImportProgress>()
  const [importError, setImportError] = useState('')
  const [livePhoto, setLivePhoto] = useState<Photo>()
  const [cropPhotoId, setCropPhotoId] = useState<string>()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [exportProgress, setExportProgress] = useState(0)
  const [analysisProgress, setAnalysisProgress] = useState(0)
  const [customSize, setCustomSize] = useState({ widthMm: 210, heightMm: 297 })
  const [restoring, setRestoring] = useState(true)
  const [showWelcome, setShowWelcome] = useState(false)
  const [flowAspectMode, setFlowAspectMode] = useState<'locked' | 'free'>('locked')
  const inputRef = useRef<HTMLInputElement>(null)
  const addInputRef = useRef<HTMLInputElement>(null)

  const selectedIndex = Math.max(0, store.pages.findIndex((page) => page.id === store.selectedPageId))
  const selectedPage = store.pages[selectedIndex]
  const selectedChapter = store.chapters.find((chapter) => chapter.id === selectedPage?.chapterId)

  useEffect(() => {
    let active = true
    void loadLibrary()
      .then((library) => {
        if (active && library.photos.length && library.chapters.length) setLibrary(library.photos, library.chapters)
      })
      .finally(() => active && setRestoring(false))
    return () => {
      active = false
    }
  }, [setLibrary])

  async function importFiles(files: File[], replace = true) {
    if (!files.length) return
    setImportError('')
    try {
      const photos = await scanFiles(files, year, setProgress)
      if (!photos.length) throw new Error(`${year}년에 촬영한 사진을 찾지 못했습니다.`)
      if (replace) {
        setProgress({ current: 1, total: 1, label: '여행과 월별 챕터를 구성하는 중' })
        const chapters = await buildChapters(photos)
        store.setLibrary(photos, chapters)
        setShowWelcome(false)
      } else {
        store.addPhotos(photos)
      }
    } catch (error) {
      setImportError(error instanceof Error ? error.message : '사진을 가져오지 못했습니다.')
    } finally {
      setProgress(undefined)
    }
  }

  async function pickFolder() {
    try {
      const files = await chooseDirectoryFiles()
      await importFiles(files)
    } catch (error) {
      if (error instanceof Error && error.message === 'FALLBACK_INPUT') inputRef.current?.click()
      else if (error instanceof DOMException && error.name === 'AbortError') return
      else setImportError('폴더를 열지 못했습니다. 아래 파일 선택을 사용해주세요.')
    }
  }

  async function createSmartLayout() {
    const targets = store.photos.filter((photo) => !photo.analysis)
    for (let index = 0; index < targets.length; index += 1) {
      setAnalysisProgress(Math.round(((index + 0.2) / targets.length) * 100))
      try {
        const analysis = await analyzePhoto(targets[index].file)
        store.setPhotoAnalysis(targets[index].id, analysis)
      } catch (error) {
        console.warn(`${targets[index].name} 재분석 실패`, error)
      }
    }
    setAnalysisProgress(0)
    store.regenerateLayouts()
  }

  function openCrop(photo: Photo) {
    if (!photo.crop) {
      store.setPhotoCrop(photo.id, {
        zoom: 1.15,
        x: photo.analysis?.focalPoint.x ?? 0.5,
        y: photo.analysis?.focalPoint.y ?? 0.5,
      })
    }
    setCropPhotoId(photo.id)
  }

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
                {[0, 1, 2, 3, 4].map((offset) => {
                  const option = CURRENT_YEAR - offset
                  return <option key={option}>{option}</option>
                })}
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
                <div><span style={{ width: `${(progress.current / progress.total) * 100}%` }} /></div>
                <small>{progress.label} · {progress.current}/{progress.total}</small>
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
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        if (event.dataTransfer.files.length) void importFiles(Array.from(event.dataTransfer.files), false)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Delete' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
          const focused = document.querySelector<HTMLElement>('.photo-cell:focus')
          if (focused?.dataset.photoId) store.removePhoto(focused.dataset.photoId)
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
            onClick={() => void exportBookPdf(store.bookSize, store.orientation, store.pages.length, setExportProgress).finally(() => setExportProgress(0))}
            disabled={Boolean(exportProgress)}
          >
            <Download /> {exportProgress ? `${exportProgress}/${store.pages.length}` : 'PDF 내보내기'}
          </button>
        </div>
      </header>

      <aside className="page-sidebar">
        <div className="sidebar-heading">
          <span>페이지</span>
          <button onClick={() => store.pages[0] && store.selectPage(store.pages[0].id)} title="포토북 첫 페이지로 이동"><ChevronsLeft /> 처음</button>
          <b>{store.pages.length} / {MAX_PAGES}</b>
        </div>
        <div className="analysis-summary">
          <span><Users /> 인물 {store.photos.filter((photo) => photo.analysis?.scene === 'people').length}</span>
          <span><Mountain /> 풍경 {store.photos.filter((photo) => photo.analysis?.scene === 'landscape').length}</span>
        </div>
        {store.pages.length >= MAX_PAGES && <div className="page-warning">50페이지 한도입니다. 사진 크기를 작게 바꿔 페이지를 줄여보세요.</div>}
        <div className="page-list">
          {store.pages.map((page, index) => (
            <button
              key={page.id}
              className={`page-thumb ${page.id === selectedPage?.id ? 'active' : ''}`}
              onClick={() => store.selectPage(page.id)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                const photoId = event.dataTransfer.getData('photo/id')
                if (photoId) store.movePhoto(photoId, page.id)
              }}
            >
              <span>{index + 1}</span>
              <MiniPage page={page} flowAspectMode={flowAspectMode} />
            </button>
          ))}
        </div>
      </aside>

      <main className="workspace">
        {selectedPage && (
          <>
            <div className="chapter-toolbar">
              <div>
                <span>{selectedChapter?.type === 'trip' ? '여행 챕터' : `${selectedChapter?.month}월 챕터`}</span>
                <input
                  value={selectedChapter?.title ?? ''}
                  aria-label="챕터 제목"
                  onChange={(event) => selectedChapter && store.updateChapter(selectedChapter.id, { title: event.target.value })}
                />
              </div>
              <span>페이지 {selectedIndex + 1}</span>
            </div>
            <div className="canvas-area">
              <button className="page-arrow" disabled={selectedIndex === 0} onClick={() => store.selectPage(store.pages[selectedIndex - 1].id)}><ChevronLeft /></button>
              <PagePaper
                page={selectedPage}
                chapter={selectedChapter}
                editable
                onOpenLive={setLivePhoto}
                croppingPhotoId={cropPhotoId}
                onCrop={openCrop}
                onCloseCrop={() => setCropPhotoId(undefined)}
                flowAspectMode={flowAspectMode}
              />
              <button className="page-arrow" disabled={selectedIndex === store.pages.length - 1} onClick={() => store.selectPage(store.pages[selectedIndex + 1].id)}><ChevronRight /></button>
            </div>
            <div className="drag-hint"><Upload size={15} /> 사진을 잡아 중앙 등 원하는 위치로 이동 · 모서리 핸들은 드래그 중 실시간 조절</div>
          </>
        )}
      </main>

      <aside className="photo-tray">
        <section className="template-section">
          <div className="tray-heading"><span>추천 배치</span><LayoutTemplate /></div>
          <div className="aspect-mode">
            <span>나머지 사진</span>
            <div>
              <button className={flowAspectMode === 'locked' ? 'active' : ''} onClick={() => setFlowAspectMode('locked')}>비율 유지</button>
              <button className={flowAspectMode === 'free' ? 'active' : ''} onClick={() => setFlowAspectMode('free')}>자유 채우기</button>
            </div>
          </div>
          {selectedPage?.type === 'photos' ? (
            <div className="template-options">
              {availableLayouts(selectedPage.photoIds.length).map((layout) => (
                <button
                  key={layout}
                  className={selectedPage.layoutId === layout ? 'active' : ''}
                  onClick={() => store.setPageLayout(selectedPage.id, layout)}
                  title={layoutLabel(layout)}
                >
                  <TemplatePreview layout={layout} count={selectedPage.photoIds.length} />
                  <span>{layoutLabel(layout)}</span>
                </button>
              ))}
            </div>
          ) : <p className="tray-empty">사진 페이지에서 추천 배치를 선택할 수 있어요.</p>}
        </section>
        <section className="photo-library">
          <div className="tray-heading"><span>사진 보관함</span><b>{store.photos.length}</b></div>
          <div className="photo-tray-list">
            {store.photos.map((photo) => (
              <button
                key={photo.id}
                className="tray-photo"
                draggable
                onDragStart={(event) => event.dataTransfer.setData('photo/id', photo.id)}
                onDoubleClick={() => {
                  const page = store.pages.find((candidate) => candidate.photoIds.includes(photo.id))
                  if (page) store.selectPage(page.id)
                  openCrop(photo)
                }}
                title={`${photo.name} · 페이지로 드래그`}
              >
                <img src={photo.thumbUrl} alt={photo.name} style={photoStyle(photo)} />
                <span>{sceneLabel(photo.analysis?.scene ?? 'other')}</span>
              </button>
            ))}
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
        </div>
      )}

      {livePhoto && <LivePhotoPicker photo={livePhoto} onClose={() => setLivePhoto(undefined)} onSelect={(data) => store.setSelectedFrame(livePhoto.id, data)} />}
      <div className="export-stage" aria-hidden>
        {store.pages.map((page, index) => (
          <PagePaper key={page.id} page={page} chapter={store.chapters.find((chapter) => chapter.id === page.chapterId)} flowAspectMode={flowAspectMode} exportIndex={index} />
        ))}
      </div>
    </div>
  )
}

function MiniPage({ page, flowAspectMode }: { page: BookPage; flowAspectMode: 'locked' | 'free' }) {
  const { photos, bookSize, orientation } = useBookStore()
  const items = page.photoIds.map((id) => photos.find((photo) => photo.id === id)).filter(Boolean) as Photo[]
  const ratio = orientation === 'portrait' ? bookSize.widthMm / bookSize.heightMm : bookSize.heightMm / bookSize.widthMm
  const preserveFlowAspect = flowAspectMode === 'locked'
  const rects = page.layoutId === 'adaptive-flow' ? computeAdaptiveLayout(items, ratio, preserveFlowAspect) : []
  const activeAnchorId = [...items]
    .filter((photo) => photo.freeFrame)
    .sort((a, b) => (b.framePriority ?? 0) - (a.framePriority ?? 0))[0]?.id
  return (
    <div className={`mini-paper type-${page.type} layout-${page.layoutId ?? ''}`} style={{ '--page-ratio': ratio } as React.CSSProperties}>
      {items.slice(0, 8).map((photo, index) => (
        <span
          className={`mini-cell ${activeAnchorId === photo.id ? 'free-anchor' : ''}`}
          key={photo.id}
          style={page.layoutId === 'adaptive-flow' ? adaptiveMiniStyle(rects[index], activeAnchorId === photo.id) : undefined}
        >
          <img src={photo.thumbUrl} alt="" style={photoStyle(photo, rects[index], ratio, preserveFlowAspect)} />
        </span>
      ))}
      {page.type === 'map' && <MapPinned />}
    </div>
  )
}

function PagePaper({ page, chapter, editable = false, onOpenLive, onCrop, onCloseCrop, croppingPhotoId, flowAspectMode = 'locked', exportIndex }: {
  page: BookPage
  chapter?: Chapter
  editable?: boolean
  onOpenLive?: (photo: Photo) => void
  onCrop?: (photo: Photo) => void
  onCloseCrop?: () => void
  croppingPhotoId?: string
  flowAspectMode?: 'locked' | 'free'
  exportIndex?: number
}) {
  const { photos, updateChapter, removePhoto, reorderPhoto, updatePhotoFrame, setPhotoCrop, movePhoto, bookSize, orientation, marginMm } = useBookStore()
  const items = page.photoIds.map((id) => photos.find((photo) => photo.id === id)).filter(Boolean) as Photo[]
  const chapterPhotos = chapter?.photoIds.map((id) => photos.find((photo) => photo.id === id)).filter(Boolean) as Photo[] ?? []
  const chapterYear = chapterPhotos[0]?.capturedAt.slice(0, 4) ?? CURRENT_YEAR
  const ratio = orientation === 'portrait' ? bookSize.widthMm / bookSize.heightMm : bookSize.heightMm / bookSize.widthMm
  const style = { '--page-ratio': ratio, '--page-padding': `${Math.max(12, marginMm * 2.4)}px` } as React.CSSProperties
  const preserveFlowAspect = flowAspectMode === 'locked'
  const adaptiveRects = page.layoutId === 'adaptive-flow' ? computeAdaptiveLayout(items, ratio, preserveFlowAspect) : []
  const activeAnchorId = [...items]
    .filter((photo) => photo.freeFrame)
    .sort((a, b) => (b.framePriority ?? 0) - (a.framePriority ?? 0))[0]?.id

  if (page.type === 'intro') {
    const cover = items[0]
    return (
      <article className="book-page intro-page" style={style} data-export-page={exportIndex}>
        {cover && <img className="cover-image" src={cover.url} alt="" style={photoStyle(cover)} />}
        <div className="cover-shade" />
        <div className="cover-copy">
          <span>{chapter?.type === 'trip' ? 'JOURNEY' : `${chapter?.month?.toString().padStart(2, '0')} / ${chapterYear}`}</span>
          <h2>{chapter?.title}</h2>
          {editable ? (
            <textarea
              placeholder="이 시기의 중요한 일을 기록해보세요…"
              value={chapter?.note}
              onChange={(event) => chapter && updateChapter(chapter.id, { note: event.target.value })}
            />
          ) : chapter?.note && <p>{chapter.note}</p>}
        </div>
      </article>
    )
  }
  if (page.type === 'map') {
    return <article className="book-page map-page" style={style} data-export-page={exportIndex}><div className="map-title"><span>OUR ROUTE</span><h2>{chapter?.title}</h2></div><TripMap photos={chapterPhotos} /></article>
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
        if (id) movePhoto(id, page.id)
      }}
    >
      <div className={`photo-grid layout-${page.layoutId ?? 'many-tiles'}`}>
        {items.map((photo, index) => (
          <div
            key={photo.id}
            className={`photo-cell size-${photo.size} ${editable ? 'editable-photo' : ''} ${activeAnchorId === photo.id ? 'free-anchor' : ''} ${croppingPhotoId === photo.id ? 'crop-editing' : ''}`}
            style={page.layoutId === 'adaptive-flow' ? adaptiveCellStyle(adaptiveRects[index], activeAnchorId === photo.id) : undefined}
            tabIndex={editable ? 0 : -1}
            data-photo-id={photo.id}
            draggable={false}
            onPointerDown={(event) => {
              if (!editable) return
              if (croppingPhotoId === photo.id) beginInlineCrop(event, photo, setPhotoCrop)
              else beginMove(event, photo, updatePhotoFrame)
            }}
            onWheel={(event) => {
              if (!editable || croppingPhotoId !== photo.id) return
              event.preventDefault()
              event.stopPropagation()
              const crop = photo.crop ?? {
                zoom: 1.15,
                x: photo.analysis?.focalPoint.x ?? 0.5,
                y: photo.analysis?.focalPoint.y ?? 0.5,
              }
              const zoom = Math.max(1, Math.min(2.5, crop.zoom * Math.exp(-event.deltaY * 0.002)))
              setPhotoCrop(photo.id, { ...crop, zoom })
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
              if (sourceId) reorderPhoto(sourceId, photo.id)
            }}
          >
            <img
              src={photo.url}
              alt={photo.name}
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
                <button onClick={() => onCrop?.(photo)} title="사진 자르기"><Crop /></button>
                {chapter?.type === 'month' && <button onClick={() => updateChapter(chapter.id, { coverPhotoId: photo.id })} title="이달의 대표 사진">대표</button>}
                <button className="delete-action" onClick={() => removePhoto(photo.id)} title="사진 삭제"><Trash2 /></button>
              </div>
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
            {editable && (
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
      </div>
    </article>
  )
}

function TemplatePreview({ layout, count }: { layout: LayoutId; count: number }) {
  return <span className={`template-preview layout-${layout}`}>{Array.from({ length: Math.min(count, 6) }, (_, index) => <i key={index} />)}</span>
}

function layoutLabel(layout: LayoutId) {
  return {
    'solo-bleed': '풀 블리드',
    'solo-frame': '갤러리',
    'duo-even': '균형 분할',
    'duo-editorial': '에디토리얼',
    'duo-stack': '와이드 스택',
    'trio-hero': '세로 강조',
    'trio-band': '풍경 강조',
    'trio-column': '3단 갤러리',
    'quad-grid': '클래식 그리드',
    'quad-feature': '메인 포커스',
    'quad-band': '상단 포커스',
    'five-magazine': '매거진',
    'five-collage': '콜라주',
    'six-mosaic': '모자이크',
    'six-filmstrip': '필름 스트립',
    'many-tiles': '타일',
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
  const slotRatio = rect ? (rect.width * pageRatio) / Math.max(rect.height, 0.001) : undefined
  const photoRatio = photo.width / photo.height
  const cropAmount = slotRatio ? 1 - Math.min(slotRatio / photoRatio, photoRatio / slotRatio) : 0
  return {
    objectPosition: `${(crop?.x ?? focal?.x ?? 0.5) * 100}% ${(crop?.y ?? focal?.y ?? 0.5) * 100}%`,
    objectFit: preserveAspect && !crop && cropAmount > 0.15 ? 'contain' : 'cover',
    background: preserveAspect && !crop && cropAmount > 0.15 ? '#eee8de' : undefined,
    transform: crop?.zoom ? `scale(${crop.zoom})` : undefined,
    transformOrigin: crop ? `${crop.x * 100}% ${crop.y * 100}%` : undefined,
  }
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
  event.preventDefault()
  const gridRect = grid.getBoundingClientRect()
  const startFrame = frameFromElements(cell, grid)
  const startX = event.clientX
  const startY = event.clientY
  let nextFrame = startFrame
  let moving = false
  cell.setPointerCapture(event.pointerId)
  const move = (moveEvent: PointerEvent) => {
    const dx = (moveEvent.clientX - startX) / gridRect.width
    const dy = (moveEvent.clientY - startY) / gridRect.height
    if (!moving && Math.hypot(dx * gridRect.width, dy * gridRect.height) < 3) return
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
