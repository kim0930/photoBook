import * as faceapi from '@vladmandic/face-api'
import type { FaceGroup, Photo } from '../types'

const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model'
const MATCH_DISTANCE = 0.55

let models: Promise<void> | undefined

async function ensureModels() {
  if (!models) {
    models = Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]).then(() => undefined).catch((error) => {
      models = undefined
      throw error
    })
  }
  return models
}

export async function groupFaces(photos: Photo[], existing: FaceGroup[], onProgress?: (current: number, total: number) => void) {
  await ensureModels()
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.45 })
  const groups = existing.map((group) => ({ ...group, photoIds: [...group.photoIds] }))
  const quality = new Map<string, number>()
  for (let index = 0; index < photos.length; index += 1) {
    const photo = photos[index]
    onProgress?.(index + 1, photos.length)
    try {
      const blob = await fetch(photo.thumbUrl).then((response) => response.blob())
      const bitmap = await createImageBitmap(blob)
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const context = canvas.getContext('2d')
      if (!context) {
        bitmap.close()
        continue
      }
      context.drawImage(bitmap, 0, 0)
      bitmap.close()
      const found = await faceapi.detectAllFaces(canvas, options).withFaceLandmarks().withFaceDescriptors()
      let shot = 1
      for (const face of found) {
        const points = face.landmarks.positions
        const eyes = Math.min(eyeAspect(points, 36), eyeAspect(points, 42))
        const smile = mouthAspect(points)
        shot = Math.min(shot, faceShotScore(eyes, smile))
        const descriptor = Array.from(face.descriptor)
        const match = nearest(groups, descriptor)
        if (match && distance(match.descriptor, descriptor) <= MATCH_DISTANCE) {
          if (!match.photoIds.includes(photo.id)) match.photoIds.push(photo.id)
        } else {
          groups.push({
            id: `face-${photo.id}-${groups.length}`,
            name: '',
            hidden: false,
            descriptor,
            photoIds: [photo.id],
            coverPhotoId: photo.id,
          })
        }
      }
      if (found.length) quality.set(photo.id, shot)
    } catch (error) {
      console.warn(`${photo.name}의 얼굴을 읽지 못했습니다.`, error)
    }
  }
  return { groups: groups.filter((group) => group.photoIds.length > 0), quality }
}

function nearest(groups: FaceGroup[], descriptor: number[]) {
  return groups.reduce<{ group?: FaceGroup; score: number }>((best, group) => {
    const score = distance(group.descriptor, descriptor)
    return score < best.score ? { group, score } : best
  }, { score: Infinity }).group
}

function distance(a: number[], b: number[]) {
  let sum = 0
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const delta = a[index] - b[index]
    sum += delta * delta
  }
  return Math.sqrt(sum)
}

function eyeAspect(points: faceapi.Point[], start: number) {
  const horizontal = span(points[start], points[start + 3])
  const vertical = (span(points[start + 1], points[start + 5]) + span(points[start + 2], points[start + 4])) / 2
  return vertical / Math.max(horizontal, 0.001)
}

function mouthAspect(points: faceapi.Point[]) {
  const width = span(points[48], points[54])
  const height = span(points[51], points[57])
  return height / Math.max(width, 0.001)
}

function span(a: faceapi.Point, b: faceapi.Point) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function faceShotScore(eyes: number, smile: number) {
  const eye = eyes < 0.18 ? 0.25 : eyes < 0.22 ? 0.55 : 1
  const mouth = smile < 0.12 ? 0.75 : 1
  return eye * mouth
}
