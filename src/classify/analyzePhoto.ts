import type { ObjectDetection } from '@tensorflow-models/coco-ssd'
import type { PhotoAnalysis, SceneType } from '../types'

let modelPromise: Promise<ObjectDetection | null> | undefined

async function getModel() {
  if (!modelPromise) {
    modelPromise = import('@tensorflow-models/coco-ssd')
      .then(({ load }) => load({ base: 'lite_mobilenet_v2' }))
      .catch((error) => {
        console.warn('사진 인식 모델을 불러오지 못해 구도 기반 분석을 사용합니다.', error)
        return null
      })
  }
  return modelPromise
}

const FOOD = new Set(['banana', 'apple', 'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake'])
const ANIMALS = new Set(['bird', 'cat', 'dog', 'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe'])
const ARCHITECTURE = new Set(['traffic light', 'fire hydrant', 'stop sign', 'bench', 'clock'])

function sceneFromTags(tags: string[], personCount: number, landscapeLikelihood: number): SceneType {
  if (personCount) return 'people'
  if (tags.some((tag) => FOOD.has(tag))) return 'food'
  if (tags.some((tag) => ANIMALS.has(tag))) return 'animal'
  if (tags.some((tag) => ARCHITECTURE.has(tag))) return 'architecture'
  if (landscapeLikelihood > 0.48) return 'landscape'
  return 'other'
}

export function analyzeBitmap(bitmap: ImageBitmap): PhotoAnalysis {
  const canvas = analysisCanvas(bitmap)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('사진 분석 캔버스를 만들 수 없습니다.')
  return buildAnalysis(canvas, visualFeatures(context.getImageData(0, 0, canvas.width, canvas.height)), [], false)
}

export async function analyzePhoto(blob: Blob): Promise<PhotoAnalysis> {
  const bitmap = await createImageBitmap(blob)
  const canvas = analysisCanvas(bitmap)
  bitmap.close()
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('사진 분석 캔버스를 만들 수 없습니다.')
  const visual = visualFeatures(context.getImageData(0, 0, canvas.width, canvas.height))
  const model = await getModel()
  const detections = model ? await model.detect(canvas, 12, 0.42) : []
  return buildAnalysis(canvas, visual, detections, Boolean(model))
}

function analysisCanvas(bitmap: ImageBitmap) {
  const maxEdge = 384
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('사진 분석 캔버스를 만들 수 없습니다.')
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas
}

function buildAnalysis(
  canvas: HTMLCanvasElement,
  visual: ReturnType<typeof visualFeatures>,
  detections: Array<{ class: string; score: number; bbox: number[] }>,
  detailed: boolean,
): PhotoAnalysis {
  const people = detections.filter((item) => item.class === 'person' && item.score >= 0.48)
  const tags = [...new Set(detections.filter((item) => item.score >= 0.48).map((item) => item.class))]
  const focalPoint = people.length
    ? {
        x: people.reduce((sum, item) => sum + item.bbox[0] + item.bbox[2] / 2, 0) / people.length / canvas.width,
        y: people.reduce((sum, item) => sum + item.bbox[1] + item.bbox[3] / 2, 0) / people.length / canvas.height,
      }
    : visual.focalPoint
  const landscapeLikelihood =
    (bitmapRatio(canvas) > 1.18 ? 0.3 : 0.08) +
    visual.natureRatio * 0.42 +
    visual.skyTopRatio * 0.28 -
    (people.length ? 0.4 : 0)
  const scene = sceneFromTags(tags, people.length, landscapeLikelihood)
  const confidence = people.length
    ? Math.max(...people.map((item) => item.score))
    : Math.min(0.92, 0.45 + Math.abs(landscapeLikelihood - 0.48))
  const importance = clamp(
    0.28 +
      (people.length ? 0.23 : 0) +
      (scene === 'landscape' ? 0.12 : 0) +
      visual.sharpness * 0.22 +
      visual.contrast * 0.15,
  )

  return {
    scene,
    confidence,
    personCount: people.length,
    importance,
    sharpness: visual.sharpness,
    brightness: visual.brightness,
    dominantColor: visual.dominantColor,
    focalPoint: { x: clamp(focalPoint.x), y: clamp(focalPoint.y) },
    tags,
    detailed,
    saturation: visual.saturation,
    edgeDensity: visual.edgeDensity,
    documentCandidate: visual.saturation < 0.22 && visual.edgeDensity > 0.1 && people.length === 0 && visual.brightness > 0.55,
  }
}

function bitmapRatio(canvas: HTMLCanvasElement) {
  return canvas.width / canvas.height
}

function visualFeatures(image: ImageData) {
  const { data, width, height } = image
  let brightness = 0
  let variance = 0
  let nature = 0
  let skyTop = 0
  let edge = 0
  let red = 0
  let green = 0
  let blue = 0
  let saturation = 0
  let focalWeight = 0
  let focalX = 0
  let focalY = 0
  const sampleStep = 2

  for (let y = 0; y < height; y += sampleStep) {
    for (let x = 0; x < width; x += sampleStep) {
      const index = (y * width + x) * 4
      const r = data[index]
      const g = data[index + 1]
      const b = data[index + 2]
      const luminance = (r * 0.299 + g * 0.587 + b * 0.114) / 255
      brightness += luminance
      variance += luminance * luminance
      red += r
      green += g
      blue += b
      const channelMax = Math.max(r, g, b)
      saturation += channelMax === 0 ? 0 : (channelMax - Math.min(r, g, b)) / channelMax
      if ((g > r * 1.05 && g > b * 0.9) || (b > r * 1.08 && b > g * 0.92)) nature += 1
      if (y < height * 0.42 && b > r * 1.08 && b > g * 1.02) skyTop += 1
      if (x + sampleStep < width) {
        const next = index + sampleStep * 4
        const difference = Math.abs(r - data[next]) + Math.abs(g - data[next + 1]) + Math.abs(b - data[next + 2])
        if (difference > 85) {
          edge += 1
          focalWeight += difference
          focalX += x * difference
          focalY += y * difference
        }
      }
    }
  }
  const count = Math.ceil(width / sampleStep) * Math.ceil(height / sampleStep)
  const average = brightness / count
  const channelMax = Math.max(red, green, blue)
  const color = channelMax === red ? '#b9705d' : channelMax === green ? '#66896f' : '#637e9e'
  return {
    brightness: average,
    contrast: clamp(Math.sqrt(Math.max(0, variance / count - average * average)) * 3.2),
    sharpness: clamp((edge / count) * 3.8),
    saturation: saturation / count,
    edgeDensity: edge / count,
    natureRatio: nature / count,
    skyTopRatio: skyTop / Math.max(1, count * 0.42),
    dominantColor: color,
    focalPoint: {
      x: focalWeight ? focalX / focalWeight / width : 0.5,
      y: focalWeight ? focalY / focalWeight / height : 0.5,
    },
  }
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, value))
}
