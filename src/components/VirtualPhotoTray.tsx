import { Maximize2, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Photo } from '../types'

export type TrayEntry =
  | { type: 'month'; key: string; label: string }
  | { type: 'day'; key: string; label: string }
  | { type: 'photo'; photo: Photo }

type TrayRow =
  | { type: 'month'; key: string; label: string; height: number }
  | { type: 'day'; key: string; label: string; height: number }
  | { type: 'photos'; key: string; photos: Photo[]; height: number }

const GAP = 7
const MONTH_H = 30
const DAY_H = 18
const OVERSCAN = 4

function buildRows(entries: TrayEntry[], columns: number, thumb: number): TrayRow[] {
  const rows: TrayRow[] = []
  let buffer: Photo[] = []
  const rowHeight = thumb + GAP

  const flush = () => {
    while (buffer.length) {
      const chunk = buffer.splice(0, columns)
      rows.push({
        type: 'photos',
        key: `photos-${chunk[0]?.id ?? rows.length}`,
        photos: chunk,
        height: rowHeight,
      })
    }
  }

  for (const entry of entries) {
    if (entry.type === 'month') {
      flush()
      rows.push({ type: 'month', key: entry.key, label: entry.label, height: MONTH_H })
    } else if (entry.type === 'day') {
      flush()
      rows.push({ type: 'day', key: entry.key, label: entry.label, height: DAY_H })
    } else {
      buffer.push(entry.photo)
      if (buffer.length >= columns) flush()
    }
  }
  flush()
  return rows
}

export function VirtualPhotoTray({
  entries,
  thumbSize,
  listRef,
  pagePlacements,
  onCanvasIds,
  selectedIds,
  focusPhotoId,
  focusToken = 0,
  onToggle,
  onOpenCrop,
  onPreview,
  onRemove,
  onInclude,
  onDragStart,
  onDragEnd,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  marqueeBoxRef,
  photoStyle,
  sceneLabel,
  photoHoldLabel,
}: {
  entries: TrayEntry[]
  thumbSize: number
  listRef: React.RefObject<HTMLDivElement | null>
  pagePlacements: Map<string, { pageId: string; number: number }>
  onCanvasIds: Set<string>
  selectedIds: Set<string>
  focusPhotoId?: string
  focusToken?: number
  onToggle: (photoId: string, event: React.MouseEvent) => void
  onOpenCrop: (photo: Photo) => void
  onPreview: (photoId: string) => void
  onRemove: (photoIds: string[]) => void
  onInclude: (photoId: string) => void
  onDragStart: (photo: Photo, selected: boolean, event: React.DragEvent) => void
  onDragEnd: () => void
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void
  marqueeBoxRef: React.RefObject<HTMLDivElement | null>
  photoStyle: (photo: Photo) => React.CSSProperties
  sceneLabel: (scene: NonNullable<Photo['analysis']>['scene']) => string
  photoHoldLabel: (exclude?: Photo['excludeReason'], hold?: Photo['holdReason']) => string | undefined
}) {
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [flashId, setFlashId] = useState<string>()
  const selectedList = useMemo(() => [...selectedIds], [selectedIds])

  useEffect(() => {
    const node = listRef.current
    if (!node) return
    const measure = () => {
      setViewport({ width: node.clientWidth, height: node.clientHeight })
      setScrollTop(node.scrollTop)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [listRef])

  const columns = Math.max(1, Math.floor((viewport.width + GAP) / (thumbSize + GAP)) || 1)
  const rows = useMemo(
    () => buildRows(entries, columns, thumbSize),
    [entries, columns, thumbSize],
  )

  const offsets = useMemo(() => {
    const tops: number[] = []
    let y = 0
    for (const row of rows) {
      tops.push(y)
      y += row.height
    }
    return { tops, total: y }
  }, [rows])

  useEffect(() => {
    if (!focusPhotoId || !viewport.height) return
    const list = listRef.current
    if (!list) return
    const rowIndex = rows.findIndex(
      (row) => row.type === 'photos' && row.photos.some((photo) => photo.id === focusPhotoId),
    )
    if (rowIndex < 0) return
    const rowTop = offsets.tops[rowIndex] ?? 0
    const rowHeight = rows[rowIndex]?.height ?? thumbSize
    const stickyPad = MONTH_H + DAY_H
    const viewTop = list.scrollTop + stickyPad
    const viewBottom = list.scrollTop + list.clientHeight
    if (rowTop >= viewTop && rowTop + rowHeight <= viewBottom) {
      setFlashId(focusPhotoId)
      return
    }
    const target = Math.max(0, rowTop - stickyPad - 4)
    list.scrollTo({ top: target, behavior: 'smooth' })
    setFlashId(focusPhotoId)
  }, [focusPhotoId, focusToken, rows, offsets.tops, thumbSize, viewport.height, listRef])

  useEffect(() => {
    if (!flashId) return
    const timer = window.setTimeout(() => setFlashId((current) => (current === flashId ? undefined : current)), 1200)
    return () => window.clearTimeout(timer)
  }, [flashId, focusToken])

  let start = 0
  let end = rows.length
  if (viewport.height > 0 && rows.length) {
    const first = Math.max(0, offsets.tops.findIndex((top, index) => top + rows[index].height > scrollTop) - OVERSCAN)
    start = first < 0 ? 0 : first
    end = rows.length
    for (let index = start; index < rows.length; index += 1) {
      if (offsets.tops[index] > scrollTop + viewport.height) {
        end = Math.min(rows.length, index + OVERSCAN)
        break
      }
    }
  }

  const visible = rows.slice(start, end)
  const sticky = useMemo(
    () => stickyHeaders(rows, offsets.tops, scrollTop),
    [rows, offsets.tops, scrollTop],
  )

  return (
    <div
      className="photo-tray-list is-virtual"
      ref={listRef}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div ref={marqueeBoxRef} className="tray-marquee" hidden />
      {sticky.month && (
        <div className="tray-sticky-headers" aria-hidden>
          <div
            className="tray-month tray-sticky-month"
            style={{ transform: sticky.monthPush ? `translateY(${sticky.monthPush}px)` : undefined }}
          >
            {sticky.month.label}
          </div>
          {sticky.day && (
            <div
              className="tray-day tray-sticky-day"
              style={{ transform: sticky.dayPush ? `translateY(${sticky.dayPush}px)` : undefined }}
            >
              {sticky.day.label}
            </div>
          )}
        </div>
      )}
      <div className="tray-virtual-space" style={{ height: offsets.total }}>
        {visible.map((row, offset) => {
          const index = start + offset
          const top = offsets.tops[index]
          if (row.type === 'month') {
            return (
              <div
                key={row.key}
                className={`tray-month tray-virtual-row${sticky.month?.key === row.key ? ' is-stuck' : ''}`}
                style={{ top, height: row.height }}
              >
                {row.label}
              </div>
            )
          }
          if (row.type === 'day') {
            return (
              <div
                key={row.key}
                className={`tray-day tray-virtual-row${sticky.day?.key === row.key ? ' is-stuck' : ''}`}
                style={{ top, height: row.height }}
              >
                {row.label}
              </div>
            )
          }
          return (
            <div
              key={row.key}
              className="tray-virtual-row tray-virtual-photos"
              style={{
                top,
                height: row.height,
                gridTemplateColumns: `repeat(${columns}, ${thumbSize}px)`,
              }}
            >
              {row.photos.map((photo) => {
                const placement = pagePlacements.get(photo.id)
                const onCanvas = onCanvasIds.has(photo.id)
                const selected = selectedIds.has(photo.id)
                return (
                  <TrayPhotoCell
                    key={photo.id}
                    photo={photo}
                    placement={placement}
                    onCanvas={onCanvas}
                    selected={selected}
                    focused={flashId === photo.id}
                    selectedIds={selectedList}
                    onToggle={onToggle}
                    onOpenCrop={onOpenCrop}
                    onPreview={onPreview}
                    onRemove={onRemove}
                    onInclude={onInclude}
                    onDragStart={onDragStart}
                    onDragEnd={onDragEnd}
                    photoStyle={photoStyle}
                    sceneLabel={sceneLabel}
                    photoHoldLabel={photoHoldLabel}
                  />
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function stickyHeaders(rows: TrayRow[], tops: number[], scrollTop: number) {
  let month: Extract<TrayRow, { type: 'month' }> | undefined
  let day: Extract<TrayRow, { type: 'day' }> | undefined
  let monthIndex = -1
  let dayIndex = -1
  let nextMonthTop = Number.POSITIVE_INFINITY
  let nextDayTop = Number.POSITIVE_INFINITY

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const top = tops[index] ?? 0
    if (row.type === 'month') {
      if (top <= scrollTop) {
        month = row
        monthIndex = index
        day = undefined
        dayIndex = -1
      } else if (nextMonthTop === Number.POSITIVE_INFINITY) {
        nextMonthTop = top
      }
    } else if (row.type === 'day') {
      if (top <= scrollTop && index > monthIndex) {
        day = row
        dayIndex = index
      } else if (index > monthIndex && nextDayTop === Number.POSITIVE_INFINITY) {
        nextDayTop = top
      }
    }
  }

  // 월 헤더 직후·일 헤더 전이면 그달 첫날을 미리 붙인다.
  if (month && !day) {
    for (let index = monthIndex + 1; index < rows.length; index += 1) {
      const row = rows[index]
      if (row.type === 'month') break
      if (row.type === 'day') {
        day = row
        dayIndex = index
        nextDayTop = Number.POSITIVE_INFINITY
        for (let next = index + 1; next < rows.length; next += 1) {
          if (rows[next].type === 'month') {
            nextMonthTop = Math.min(nextMonthTop, tops[next] ?? nextMonthTop)
            break
          }
          if (rows[next].type === 'day') {
            nextDayTop = tops[next] ?? nextDayTop
            break
          }
        }
        break
      }
    }
  } else if (day && dayIndex >= 0) {
    nextDayTop = Number.POSITIVE_INFINITY
    for (let index = dayIndex + 1; index < rows.length; index += 1) {
      const row = rows[index]
      if (row.type === 'month') {
        nextMonthTop = Math.min(nextMonthTop, tops[index] ?? nextMonthTop)
        break
      }
      if (row.type === 'day') {
        nextDayTop = tops[index] ?? nextDayTop
        break
      }
    }
  }

  const monthPush = Number.isFinite(nextMonthTop)
    ? Math.min(0, nextMonthTop - scrollTop - MONTH_H)
    : 0
  const dayCeiling = MONTH_H + DAY_H
  const dayBoundary = Math.min(nextDayTop, nextMonthTop)
  const dayPush = Number.isFinite(dayBoundary)
    ? Math.min(0, dayBoundary - scrollTop - dayCeiling)
    : 0

  return { month, day, monthPush, dayPush }
}

function TrayPhotoCell({
  photo,
  placement,
  onCanvas,
  selected,
  focused,
  selectedIds,
  onToggle,
  onOpenCrop,
  onPreview,
  onRemove,
  onInclude,
  onDragStart,
  onDragEnd,
  photoStyle,
  sceneLabel,
  photoHoldLabel,
}: {
  photo: Photo
  placement?: { pageId: string; number: number }
  onCanvas: boolean
  selected: boolean
  focused?: boolean
  selectedIds: string[]
  onToggle: (photoId: string, event: React.MouseEvent) => void
  onOpenCrop: (photo: Photo) => void
  onPreview: (photoId: string) => void
  onRemove: (photoIds: string[]) => void
  onInclude: (photoId: string) => void
  onDragStart: (photo: Photo, selected: boolean, event: React.DragEvent) => void
  onDragEnd: () => void
  photoStyle: (photo: Photo) => React.CSSProperties
  sceneLabel: (scene: NonNullable<Photo['analysis']>['scene']) => string
  photoHoldLabel: (exclude?: Photo['excludeReason'], hold?: Photo['holdReason']) => string | undefined
}) {
  return (
    <div className={`tray-photo-wrap${selected ? ' is-selected' : ''}${focused ? ' is-focused' : ''}`} data-photo-id={photo.id}>
      <button
        className={`tray-photo${placement ? ' placed' : ''}${onCanvas ? ' on-canvas' : ''}${selected ? ' is-selected' : ''}${focused ? ' is-focused' : ''}`}
        data-photo-id={photo.id}
        draggable
        onDragStart={(event) => onDragStart(photo, selected, event)}
        onDragEnd={onDragEnd}
        onClick={(event) => onToggle(photo.id, event)}
        onDoubleClick={() => onOpenCrop(photo)}
        title={[
          photo.name,
          photoHoldLabel(photo.excludeReason, photo.holdReason),
          'Ctrl/⌘ 클릭·드래그로 다중 선택',
          placement ? `${placement.number}페이지로 이동` : '페이지로 드래그',
        ].filter(Boolean).join(' · ')}
      >
        <img src={photo.thumbUrl} alt={photo.name} loading="lazy" decoding="async" style={photoStyle(photo)} />
        {placement && <b className="page-mark">{placement.number}</b>}
        {(photo.excludeReason || photo.holdReason) && (
          <em className="exclude-mark">{photoHoldLabel(photo.excludeReason, photo.holdReason)}</em>
        )}
        {photo.excludeReason && (
          <span
            className="include-mark"
            onClick={(event) => {
              event.stopPropagation()
              onInclude(photo.id)
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
          onPreview(photo.id)
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
          onRemove(selected && selectedIds.includes(photo.id) ? selectedIds : [photo.id])
        }}
      >
        <Trash2 />
      </button>
    </div>
  )
}

export function libraryEntries(photos: Photo[]): TrayEntry[] {
  const sorted = [...photos].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
  const entries: TrayEntry[] = []
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
