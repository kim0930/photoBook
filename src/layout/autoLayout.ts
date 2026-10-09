import { bookPhoto } from '../curate/bookSelection'
import { MAX_PAGES } from '../settings/bookSize'
import type { BookPage, Chapter, Photo } from '../types'

const WEIGHTS = { small: 0.65, medium: 1, large: 1.7 }
export type LayoutId =
  | 'solo-bleed'
  | 'solo-frame'
  | 'solo-banner'
  | 'duo-even'
  | 'duo-editorial'
  | 'duo-stack'
  | 'duo-sidebar'
  | 'duo-banner'
  | 'trio-hero'
  | 'trio-hero-right'
  | 'trio-band'
  | 'trio-footer'
  | 'trio-column'
  | 'trio-rows'
  | 'quad-grid'
  | 'quad-feature'
  | 'quad-feature-right'
  | 'quad-band'
  | 'quad-footer'
  | 'quad-columns'
  | 'five-magazine'
  | 'five-collage'
  | 'five-strip'
  | 'five-sidebar'
  | 'five-columns'
  | 'six-mosaic'
  | 'six-filmstrip'
  | 'six-grid'
  | 'six-rows'
  | 'many-tiles'
  | 'many-rows'
  | 'many-portrait'
  | 'adaptive-flow'

export function photosPerPage(photos: Photo[]) {
  if (!photos.length) return 1
  const weight = photos.reduce((sum, photo) => sum + (photo.layoutWeight ?? WEIGHTS[photo.size]), 0) / photos.length
  return Math.max(2, Math.min(8, Math.round(6 / weight)))
}

export function buildPages(chapters: Chapter[], photos: Photo[], revision = 0): BookPage[] {
  const byId = new Map(photos.map((photo) => [photo.id, photo]))
  const groups: BookPage[][] = []
  for (const chapter of chapters) {
    const kept = chapter.photoIds.map((id) => byId.get(id)).filter(bookPhoto)
    if (!kept.length) continue
    const cover = bookPhoto(byId.get(chapter.coverPhotoId ?? '')) ? chapter.coverPhotoId : kept[0].id
    const pages: BookPage[] = []
    if (!chapter.skipIntro) {
      pages.push({
        id: `${chapter.id}-intro`,
        chapterId: chapter.id,
        type: 'intro',
        photoIds: cover ? [cover] : [],
      })
    }
    if (chapter.type === 'trip' && !chapter.skipMap) {
      pages.push({ id: `${chapter.id}-map`, chapterId: chapter.id, type: 'map', photoIds: [] })
    }
    const chapterPhotos = kept.filter((photo) => photo.id !== cover)
    let offset = 0
    let pageIndex = 0
    while (offset < chapterPhotos.length) {
      const candidates = chapterPhotos.slice(offset, offset + 8)
      const baseCount = photosPerPage(candidates)
      const variation = hash(`${chapter.id}-${pageIndex}-${revision}`) % 3 - 1
      const count = Math.max(2, Math.min(8, baseCount + variation))
      const chronological = chapterPhotos.slice(offset, offset + count)
      const chunk = chronological.some((photo) => photo.manuallyPositioned || photo.layoutLocked)
        ? chronological
        : emphasizeBestPhoto(chronological)
      pages.push({
        id: `${chapter.id}-photos-${offset}`,
        chapterId: chapter.id,
        type: 'photos',
        photoIds: chunk.map((photo) => photo.id),
        layoutId: chunk.some((photo) => photo.manuallyPositioned || photo.layoutLocked)
          ? 'adaptive-flow'
          : pickLayout(chunk, pageIndex, revision),
      })
      offset += chronological.length
      pageIndex += 1
    }
    groups.push(pages)
  }
  return limitChapterPages(groups, MAX_PAGES)
}

function limitChapterPages(groups: BookPage[][], max: number) {
  const total = groups.reduce((sum, group) => sum + group.length, 0)
  if (!groups.length || total <= max) return groups.flat()
  const share = Math.max(1, Math.floor(max / groups.length))
  const taken = groups.map((group) => group.slice(0, Math.min(group.length, share)))
  let used = taken.reduce((sum, group) => sum + group.length, 0)
  for (let index = 0; used < max && index < groups.length; index += 1) {
    const more = groups[index].slice(taken[index].length, taken[index].length + (max - used))
    taken[index].push(...more)
    used += more.length
  }
  return taken.flat()
}

function emphasizeBestPhoto(photos: Photo[]) {
  if (photos.length < 3) return photos
  const hero = [...photos].sort((a, b) => photoScore(b) - photoScore(a))[0]
  return [hero, ...photos.filter((photo) => photo.id !== hero.id)]
}

function photoScore(photo: Photo) {
  return (photo.quality ?? photo.analysis?.importance ?? 0.5) + (photo.size === 'large' ? 0.35 : photo.size === 'small' ? -0.2 : 0)
}

export function pickLayout(photos: Photo[], pageIndex = 0, revision = 0): LayoutId {
  const count = photos.length
  const key = hash(`${photos.map((photo) => photo.id).join('|')}-${pageIndex}-${revision}`)
  const hasWideHero = photos[0] && photos[0].width / photos[0].height > 1.35
  const options = availableLayouts(count).filter((id) => id !== 'adaptive-flow')
  if (count === 2 && hasWideHero) return key % 2 ? 'duo-stack' : 'duo-banner'
  if (count === 3 && hasWideHero) return key % 2 ? 'trio-band' : 'trio-footer'
  return options[key % options.length]
}

export function availableLayouts(count: number): LayoutId[] {
  if (count <= 1) return ['solo-bleed', 'solo-frame', 'solo-banner']
  if (count === 2) return ['adaptive-flow', 'duo-even', 'duo-editorial', 'duo-stack', 'duo-sidebar', 'duo-banner']
  if (count === 3) return ['adaptive-flow', 'trio-hero', 'trio-hero-right', 'trio-band', 'trio-footer', 'trio-column', 'trio-rows']
  if (count === 4) return ['adaptive-flow', 'quad-grid', 'quad-feature', 'quad-feature-right', 'quad-band', 'quad-footer', 'quad-columns']
  if (count === 5) return ['adaptive-flow', 'five-magazine', 'five-collage', 'five-strip', 'five-sidebar', 'five-columns']
  if (count === 6) return ['adaptive-flow', 'six-mosaic', 'six-filmstrip', 'six-grid', 'six-rows']
  return ['adaptive-flow', 'many-tiles', 'many-rows', 'many-portrait', 'six-grid']
}

export interface AdaptiveRect {
  x: number
  y: number
  width: number
  height: number
}

export function computeAdaptiveLayout(
  photos: Photo[],
  pageRatio: number,
  preserveFlowAspect = true,
): AdaptiveRect[] {
  const result = new Map<string, AdaptiveRect>()

  function solve(items: Photo[], rect: AdaptiveRect): { score: number; entries: Array<[string, AdaptiveRect]> } | undefined {
    if (!items.length) return
    if (items.length === 1) {
      const slotRatio = (rect.width * pageRatio) / Math.max(rect.height, 0.001)
      const photoRatio = items[0].width / items[0].height
      const visibleFraction = Math.min(slotRatio / photoRatio, photoRatio / slotRatio)
      const crop = 1 - visibleFraction
      return {
        score: crop <= 0.15 ? crop : 0.15 + (crop - 0.15) * 7,
        entries: [[items[0].id, rect]],
      }
    }
    const weights = items.map((photo) => Math.max(0.35, photo.layoutWeight ?? WEIGHTS[photo.size]))
    const total = weights.reduce((sum, value) => sum + value, 0)
    let accumulated = 0
    let best: { score: number; entries: Array<[string, AdaptiveRect]> } | undefined
    for (let splitIndex = 1; splitIndex < items.length; splitIndex += 1) {
      accumulated += weights[splitIndex - 1]
      const fraction = accumulated / total
      const first = items.slice(0, splitIndex)
      const second = items.slice(splitIndex)
      const candidates: Array<[AdaptiveRect, AdaptiveRect]> = [
        [
          { ...rect, width: rect.width * fraction },
          { x: rect.x + rect.width * fraction, y: rect.y, width: rect.width * (1 - fraction), height: rect.height },
        ],
        [
          { ...rect, height: rect.height * fraction },
          { x: rect.x, y: rect.y + rect.height * fraction, width: rect.width, height: rect.height * (1 - fraction) },
        ],
      ]
      for (const [firstRect, secondRect] of candidates) {
        const firstResult = solve(first, firstRect)
        const secondResult = solve(second, secondRect)
        if (!firstResult || !secondResult) continue
        const score = firstResult.score + secondResult.score
        if (!best || score < best.score) {
          best = { score, entries: [...firstResult.entries, ...secondResult.entries] }
        }
      }
    }
    return best ?? { score: Infinity, entries: [] }
  }

  function divide(items: Photo[], rect: AdaptiveRect) {
    if (!preserveFlowAspect) {
      divideFreely(items, rect)
      return
    }
    const solution = solve(items, rect)
    solution?.entries.forEach(([id, itemRect]) => result.set(id, itemRect))
  }

  function divideFreely(items: Photo[], rect: AdaptiveRect) {
    if (!items.length) return
    if (items.length === 1) {
      result.set(items[0].id, rect)
      return
    }
    const weights = items.map((photo) => Math.max(0.35, photo.layoutWeight ?? WEIGHTS[photo.size]))
    const total = weights.reduce((sum, value) => sum + value, 0)
    let accumulated = weights[0]
    let splitIndex = 1
    let bestDistance = Math.abs(accumulated - total / 2)
    for (let index = 1; index < items.length; index += 1) {
      const distance = Math.abs(accumulated + weights[index] - total / 2)
      if (distance >= bestDistance) break
      accumulated += weights[index]
      splitIndex = index + 1
      bestDistance = distance
    }
    const first = items.slice(0, splitIndex)
    const second = items.slice(splitIndex)
    const split = chooseFreeSplit(rect, accumulated / total, pageRatio)
    const [firstRect, secondRect] = splitPair(rect, split.fraction, split.horizontal)
    divideFreely(first, firstRect)
    divideFreely(second, secondRect)
  }

  const locked = photos
    .filter((photo) => photo.layoutLocked && photo.freeFrame)
    .map((photo) => ({ id: photo.id, frame: clampFrame(photo.freeFrame!, 1) }))
  const obstacles = locked.map((item) => item.frame)
  const anchored = photos
    .filter((photo) => !photo.layoutLocked && photo.freeFrame)
    .sort((a, b) => (b.framePriority ?? 0) - (a.framePriority ?? 0) || a.id.localeCompare(b.id))
    .map((photo) => ({ id: photo.id, frame: clampFrame(photo.freeFrame!, 1) }))
  const collides = anchored.some((item, index) => (
    obstacles.some((obstacle) => overlapArea(item.frame, obstacle) > 0.0008)
    || anchored.some((other, otherIndex) => otherIndex !== index && overlapArea(item.frame, other.frame) > 0.0008)
  ))
  const placed = collides
    ? anchored.slice(0, 1).map((item) => ({ ...item, frame: avoidObstacles(item.frame, obstacles) }))
    : anchored
  const fixed = [...locked, ...placed]
  if (!fixed.length) {
    divide(photos, { x: 0, y: 0, width: 1, height: 1 })
  } else {
    let regions: AdaptiveRect[] = [{ x: 0, y: 0, width: 1, height: 1 }]
    for (const item of fixed) regions = regions.flatMap((region) => subtractRect(region, item.frame))
    regions = regions.filter((region) => region.width > 0.025 && region.height > 0.025)
    const flowing = photos.filter((photo) => !fixed.some((item) => item.id === photo.id))
    if (!regions.length) {
      const occupied = fixed.map((item) => item.frame)
      flowing.forEach((photo, index) => {
        const frame = avoidObstacles({
          x: 0.02 + (index % 3) * 0.22,
          y: 0.02,
          width: 0.18,
          height: 0.18,
        }, occupied)
        result.set(photo.id, frame)
        occupied.push(frame)
      })
    } else {
      const groups = regions.map(() => [] as Photo[])
      const assignedWeights = regions.map(() => 0)
      for (const photo of flowing) {
        let bestRegion = 0
        let bestLoad = Infinity
        for (let index = 0; index < regions.length; index += 1) {
          const area = regions[index].width * pageRatio * regions[index].height
          const load = assignedWeights[index] / Math.max(area, 0.001)
          if (load < bestLoad) {
            bestLoad = load
            bestRegion = index
          }
        }
        groups[bestRegion].push(photo)
        assignedWeights[bestRegion] += Math.max(0.35, photo.layoutWeight ?? WEIGHTS[photo.size])
      }
      groups.forEach((group, index) => divide(group, regions[index]))
    }
    fixed.forEach((item) => result.set(item.id, item.frame))
  }
  const occupied = [...result.values()]
  return photos.map((photo) => {
    const existing = result.get(photo.id)
    if (existing) return existing
    const frame = avoidObstacles({ x: 0.02, y: 0.02, width: 0.2, height: 0.2 }, occupied)
    occupied.push(frame)
    return frame
  })
}

export interface PhotoGutter {
  id: string
  axis: 'x' | 'y'
  at: number
  from: number
  to: number
  before: string[]
  after: string[]
}

export function findPhotoGutters(items: { id: string; rect: AdaptiveRect }[]): PhotoGutter[] {
  const raw: PhotoGutter[] = []
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const gutter = sharedEdge(items[i], items[j])
      if (gutter) raw.push(gutter)
    }
  }
  const sorted = [...raw].sort((a, b) => a.axis.localeCompare(b.axis) || a.at - b.at || a.from - b.from)
  const merged: PhotoGutter[] = []
  for (const gutter of sorted) {
    const last = merged[merged.length - 1]
    const copy = { ...gutter, before: [...gutter.before], after: [...gutter.after] }
    if (last && last.axis === copy.axis && Math.abs(last.at - copy.at) <= 0.04 && copy.from <= last.to + 0.04) {
      last.from = Math.min(last.from, copy.from)
      last.to = Math.max(last.to, copy.to)
      last.at = (last.at + copy.at) / 2
      for (const id of copy.before) if (!last.before.includes(id)) last.before.push(id)
      for (const id of copy.after) if (!last.after.includes(id)) last.after.push(id)
      last.id = `${last.axis}-${last.before.join('.')}-${last.after.join('.')}`
    } else {
      merged.push(copy)
    }
  }
  return merged
}

function sharedEdge(a: { id: string; rect: AdaptiveRect }, b: { id: string; rect: AdaptiveRect }): PhotoGutter | undefined {
  const [left, right] = a.rect.x <= b.rect.x ? [a, b] : [b, a]
  const gapX = right.rect.x - (left.rect.x + left.rect.width)
  const overlapY = Math.min(left.rect.y + left.rect.height, right.rect.y + right.rect.height) - Math.max(left.rect.y, right.rect.y)
  if (Math.abs(gapX) <= 0.04 && overlapY > 0.08) {
    return {
      id: `x-${left.id}-${right.id}`,
      axis: 'x',
      at: (left.rect.x + left.rect.width + right.rect.x) / 2,
      from: Math.max(left.rect.y, right.rect.y),
      to: Math.min(left.rect.y + left.rect.height, right.rect.y + right.rect.height),
      before: [left.id],
      after: [right.id],
    }
  }
  const [top, bottom] = a.rect.y <= b.rect.y ? [a, b] : [b, a]
  const gapY = bottom.rect.y - (top.rect.y + top.rect.height)
  const overlapX = Math.min(top.rect.x + top.rect.width, bottom.rect.x + bottom.rect.width) - Math.max(top.rect.x, bottom.rect.x)
  if (Math.abs(gapY) <= 0.04 && overlapX > 0.08) {
    return {
      id: `y-${top.id}-${bottom.id}`,
      axis: 'y',
      at: (top.rect.y + top.rect.height + bottom.rect.y) / 2,
      from: Math.max(top.rect.x, bottom.rect.x),
      to: Math.min(top.rect.x + top.rect.width, bottom.rect.x + bottom.rect.width),
      before: [top.id],
      after: [bottom.id],
    }
  }
  return undefined
}

const FREE_MAX_RATIO = 2.4

function visualRatio(rect: AdaptiveRect, pageRatio: number) {
  return (rect.width * pageRatio) / Math.max(rect.height, 0.001)
}

function fractionBounds(rect: AdaptiveRect, pageRatio: number, horizontal: boolean) {
  const ratio = Math.max(visualRatio(rect, pageRatio), 0.001)
  const min = 1 / FREE_MAX_RATIO
  const lower = horizontal ? min / ratio : ratio / FREE_MAX_RATIO
  const upper = horizontal ? FREE_MAX_RATIO / ratio : ratio / min
  return {
    minFraction: Math.max(lower, 1 - upper),
    maxFraction: Math.min(upper, 1 - lower),
  }
}

function splitPair(rect: AdaptiveRect, fraction: number, horizontal: boolean): [AdaptiveRect, AdaptiveRect] {
  if (horizontal) {
    return [
      { ...rect, width: rect.width * fraction },
      { x: rect.x + rect.width * fraction, y: rect.y, width: rect.width * (1 - fraction), height: rect.height },
    ]
  }
  return [
    { ...rect, height: rect.height * fraction },
    { x: rect.x, y: rect.y + rect.height * fraction, width: rect.width, height: rect.height * (1 - fraction) },
  ]
}

function aspectPenalty(rect: AdaptiveRect, pageRatio: number) {
  const ratio = visualRatio(rect, pageRatio)
  const min = 1 / FREE_MAX_RATIO
  if (ratio < min) return min / ratio - 1
  if (ratio > FREE_MAX_RATIO) return ratio / FREE_MAX_RATIO - 1
  return 0
}

function chooseFreeSplit(rect: AdaptiveRect, rawFraction: number, pageRatio: number) {
  const longSide = rect.width * pageRatio >= rect.height
  let best: { horizontal: boolean; fraction: number; penalty: number } | undefined
  for (const horizontal of [true, false]) {
    const { minFraction, maxFraction } = fractionBounds(rect, pageRatio, horizontal)
    const fraction = minFraction <= maxFraction
      ? Math.min(maxFraction, Math.max(minFraction, rawFraction))
      : Math.min(0.62, Math.max(0.38, rawFraction))
    const [first, second] = splitPair(rect, fraction, horizontal)
    const penalty = aspectPenalty(first, pageRatio) + aspectPenalty(second, pageRatio) + (horizontal === longSide ? 0 : 0.08)
    if (!best || penalty < best.penalty) best = { horizontal, fraction, penalty }
  }
  return best ?? { horizontal: longSide, fraction: 0.5, penalty: 0 }
}

function clampFrame(frame: AdaptiveRect, limit: number): AdaptiveRect {
  const width = Math.min(limit, Math.max(0.12, frame.width))
  const height = Math.min(limit, Math.max(0.12, frame.height))
  return {
    width,
    height,
    x: Math.max(0, Math.min(frame.x, 1 - width)),
    y: Math.max(0, Math.min(frame.y, 1 - height)),
  }
}

function subtractRect(region: AdaptiveRect, hole: AdaptiveRect): AdaptiveRect[] {
  const x1 = Math.max(region.x, hole.x)
  const y1 = Math.max(region.y, hole.y)
  const x2 = Math.min(region.x + region.width, hole.x + hole.width)
  const y2 = Math.min(region.y + region.height, hole.y + hole.height)
  if (x2 - x1 <= 0.001 || y2 - y1 <= 0.001) return [region]
  const pieces: AdaptiveRect[] = []
  if (y1 - region.y > 0.025) pieces.push({ x: region.x, y: region.y, width: region.width, height: y1 - region.y })
  if (region.y + region.height - y2 > 0.025) {
    pieces.push({ x: region.x, y: y2, width: region.width, height: region.y + region.height - y2 })
  }
  if (x1 - region.x > 0.025) pieces.push({ x: region.x, y: y1, width: x1 - region.x, height: y2 - y1 })
  if (region.x + region.width - x2 > 0.025) {
    pieces.push({ x: x2, y: y1, width: region.x + region.width - x2, height: y2 - y1 })
  }
  return pieces
}

function overlapArea(a: AdaptiveRect, b: AdaptiveRect) {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  if (width <= 0 || height <= 0) return 0
  return width * height
}

export function avoidObstacles(frame: AdaptiveRect, obstacles: AdaptiveRect[]): AdaptiveRect {
  let next = clampFrame(frame, 1)
  if (!obstacles.length || !obstacles.some((obstacle) => overlapArea(next, obstacle) > 0)) return next
  for (let pass = 0; pass < 6; pass += 1) {
    const obstacle = obstacles.find((item) => overlapArea(next, item) > 0)
    if (!obstacle) return next
    const before = overlapArea(next, obstacle)
    const candidates = [
      { ...next, x: obstacle.x - next.width },
      { ...next, x: obstacle.x + obstacle.width },
      { ...next, y: obstacle.y - next.height },
      { ...next, y: obstacle.y + obstacle.height },
    ].map((candidate) => clampFrame(candidate, 1))
    const ranked = candidates
      .map((candidate) => ({ candidate, hit: obstacles.reduce((sum, item) => sum + overlapArea(candidate, item), 0) }))
      .sort((a, b) => a.hit - b.hit)
    if (ranked[0].hit < before - 0.0001) {
      next = ranked[0].candidate
      continue
    }
    break
  }
  if (!obstacles.some((obstacle) => overlapArea(next, obstacle) > 0)) return next
  const free = obstacles
    .reduce((regions, obstacle) => regions.flatMap((region) => subtractRect(region, obstacle)), [{ x: 0, y: 0, width: 1, height: 1 }])
    .filter((region) => region.width >= 0.12 && region.height >= 0.12)
    .sort((a, b) => b.width * b.height - a.width * a.height)
  if (!free[0]) return next
  return clampFrame({
    x: free[0].x,
    y: free[0].y,
    width: Math.min(next.width, free[0].width),
    height: Math.min(next.height, free[0].height),
  }, 1)
}

function hash(value: string) {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return Math.abs(result)
}
