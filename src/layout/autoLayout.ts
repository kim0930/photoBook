import type { BookPage, Chapter, Photo } from '../types'

const WEIGHTS = { small: 0.65, medium: 1, large: 1.7 }
export type LayoutId =
  | 'solo-bleed'
  | 'solo-frame'
  | 'duo-even'
  | 'duo-editorial'
  | 'duo-stack'
  | 'trio-hero'
  | 'trio-band'
  | 'trio-column'
  | 'quad-grid'
  | 'quad-feature'
  | 'quad-band'
  | 'five-magazine'
  | 'five-collage'
  | 'six-mosaic'
  | 'six-filmstrip'
  | 'many-tiles'
  | 'adaptive-flow'

export function photosPerPage(photos: Photo[]) {
  if (!photos.length) return 1
  const weight = photos.reduce((sum, photo) => sum + (photo.layoutWeight ?? WEIGHTS[photo.size]), 0) / photos.length
  return Math.max(2, Math.min(8, Math.round(6 / weight)))
}

export function buildPages(chapters: Chapter[], photos: Photo[], revision = 0): BookPage[] {
  const byId = new Map(photos.map((photo) => [photo.id, photo]))
  const pages: BookPage[] = []
  for (const chapter of chapters) {
    pages.push({
      id: `${chapter.id}-intro`,
      chapterId: chapter.id,
      type: 'intro',
      photoIds: chapter.coverPhotoId ? [chapter.coverPhotoId] : [],
    })
    if (chapter.type === 'trip') {
      pages.push({ id: `${chapter.id}-map`, chapterId: chapter.id, type: 'map', photoIds: [] })
    }
    const chapterPhotos = chapter.photoIds
      .filter((id) => id !== chapter.coverPhotoId)
      .map((id) => byId.get(id))
      .filter((photo): photo is Photo => Boolean(photo))
    let offset = 0
    let pageIndex = 0
    while (offset < chapterPhotos.length) {
      const candidates = chapterPhotos.slice(offset, offset + 8)
      const baseCount = photosPerPage(candidates)
      const variation = hash(`${chapter.id}-${pageIndex}-${revision}`) % 3 - 1
      const count = Math.max(2, Math.min(8, baseCount + variation))
      const chronological = chapterPhotos.slice(offset, offset + count)
      const chunk = chronological.some((photo) => photo.manuallyPositioned)
        ? chronological
        : emphasizeBestPhoto(chronological)
      pages.push({
        id: `${chapter.id}-photos-${offset}`,
        chapterId: chapter.id,
        type: 'photos',
        photoIds: chunk.map((photo) => photo.id),
        layoutId: chunk.some((photo) => photo.manuallyPositioned)
          ? 'adaptive-flow'
          : pickLayout(chunk, pageIndex, revision),
      })
      offset += chronological.length
      pageIndex += 1
    }
  }
  return pages.slice(0, 50)
}

function emphasizeBestPhoto(photos: Photo[]) {
  if (photos.length < 3) return photos
  const hero = [...photos].sort((a, b) => photoScore(b) - photoScore(a))[0]
  return [hero, ...photos.filter((photo) => photo.id !== hero.id)]
}

function photoScore(photo: Photo) {
  return (photo.analysis?.importance ?? 0.5) + (photo.size === 'large' ? 0.35 : photo.size === 'small' ? -0.2 : 0)
}

export function pickLayout(photos: Photo[], pageIndex = 0, revision = 0): LayoutId {
  const count = photos.length
  const key = hash(`${photos.map((photo) => photo.id).join('|')}-${pageIndex}-${revision}`)
  const hasWideHero = photos[0] && photos[0].width / photos[0].height > 1.35
  if (count <= 1) return key % 2 ? 'solo-frame' : 'solo-bleed'
  if (count === 2) return hasWideHero ? 'duo-stack' : key % 2 ? 'duo-editorial' : 'duo-even'
  if (count === 3) return hasWideHero ? 'trio-band' : key % 2 ? 'trio-hero' : 'trio-column'
  if (count === 4) return key % 3 === 0 ? 'quad-grid' : key % 3 === 1 ? 'quad-feature' : 'quad-band'
  if (count === 5) return key % 2 ? 'five-magazine' : 'five-collage'
  if (count === 6) return key % 2 ? 'six-mosaic' : 'six-filmstrip'
  return 'many-tiles'
}

export function availableLayouts(count: number): LayoutId[] {
  if (count <= 1) return ['solo-bleed', 'solo-frame']
  if (count === 2) return ['adaptive-flow', 'duo-even', 'duo-editorial', 'duo-stack']
  if (count === 3) return ['adaptive-flow', 'trio-hero', 'trio-band', 'trio-column']
  if (count === 4) return ['adaptive-flow', 'quad-grid', 'quad-feature', 'quad-band']
  if (count === 5) return ['adaptive-flow', 'five-magazine', 'five-collage', 'many-tiles']
  if (count === 6) return ['adaptive-flow', 'six-mosaic', 'six-filmstrip', 'many-tiles']
  return ['adaptive-flow', 'many-tiles', 'six-mosaic', 'five-magazine']
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
  const anchor = [...photos]
    .filter((photo) => photo.freeFrame)
    .sort((a, b) => (b.framePriority ?? 0) - (a.framePriority ?? 0))[0]

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
    const fraction = accumulated / total
    const first = items.slice(0, splitIndex)
    const second = items.slice(splitIndex)
    if (rect.width * pageRatio >= rect.height) {
      divideFreely(first, { ...rect, width: rect.width * fraction })
      divideFreely(second, {
        x: rect.x + rect.width * fraction,
        y: rect.y,
        width: rect.width * (1 - fraction),
        height: rect.height,
      })
    } else {
      divideFreely(first, { ...rect, height: rect.height * fraction })
      divideFreely(second, {
        x: rect.x,
        y: rect.y + rect.height * fraction,
        width: rect.width,
        height: rect.height * (1 - fraction),
      })
    }
  }

  const flowingPhotos = anchor ? photos.filter((photo) => photo.id !== anchor.id) : photos
  if (anchor?.freeFrame) {
    const frame = {
      width: Math.min(0.9, anchor.freeFrame.width),
      height: Math.min(0.9, anchor.freeFrame.height),
      x: Math.min(anchor.freeFrame.x, 1 - Math.min(0.9, anchor.freeFrame.width)),
      y: Math.min(anchor.freeFrame.y, 1 - Math.min(0.9, anchor.freeFrame.height)),
    }
    const regions = [
      { x: 0, y: 0, width: 1, height: frame.y },
      { x: 0, y: frame.y + frame.height, width: 1, height: 1 - frame.y - frame.height },
      { x: 0, y: frame.y, width: frame.x, height: frame.height },
      { x: frame.x + frame.width, y: frame.y, width: 1 - frame.x - frame.width, height: frame.height },
    ].filter((region) => region.width > 0.025 && region.height > 0.025)
    const groups = regions.map(() => [] as Photo[])
    const assignedWeights = regions.map(() => 0)
    for (const photo of flowingPhotos) {
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
    result.set(anchor.id, frame)
  } else {
    divide(flowingPhotos, { x: 0, y: 0, width: 1, height: 1 })
  }
  return photos.map((photo) => result.get(photo.id) ?? { x: 0, y: 0, width: 1, height: 1 })
}

function hash(value: string) {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return Math.abs(result)
}
