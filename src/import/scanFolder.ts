import * as exifr from 'exifr'
import heic2any from 'heic2any'
import { analyzePhoto } from '../classify/analyzePhoto'
import { persistPhoto } from '../db'
import type { ImportProgress, Photo } from '../types'

const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|heic|heif)$/i
const MOVIE_EXTENSIONS = /\.(mov|mp4)$/i

function baseName(name: string) {
  return name.replace(/\.[^.]+$/, '').toLowerCase()
}

async function decodeImage(file: File): Promise<Blob> {
  if (!/\.hei[cf]$/i.test(file.name)) return file
  const converted = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 })
  return Array.isArray(converted) ? converted[0] : converted
}

async function imageInfo(blob: Blob) {
  const bitmap = await createImageBitmap(blob)
  const result = { width: bitmap.width, height: bitmap.height }
  bitmap.close()
  return result
}

async function makeThumbnail(blob: Blob, maxSize = 640): Promise<Blob> {
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height))
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(bitmap.width * scale)),
    Math.max(1, Math.round(bitmap.height * scale)),
  )
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('이미지를 처리할 수 없습니다.')
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 })
}

export async function scanFiles(
  files: File[],
  year: number,
  onProgress: (progress: ImportProgress) => void,
): Promise<Photo[]> {
  const images = files.filter((file) => IMAGE_EXTENSIONS.test(file.name))
  const movies = new Map(
    files
      .filter((file) => MOVIE_EXTENSIONS.test(file.name))
      .map((file) => [baseName(file.name), file]),
  )
  const photos: Photo[] = []

  for (let index = 0; index < images.length; index += 1) {
    const file = images[index]
    onProgress({ current: index + 1, total: images.length, label: file.name })
    try {
      const metadata = await exifr.parse(file, {
        pick: ['DateTimeOriginal', 'CreateDate', 'GPSLatitude', 'GPSLongitude'],
        translateValues: false,
      })
      const captured = metadata?.DateTimeOriginal ?? metadata?.CreateDate ?? new Date(file.lastModified)
      const capturedAt = new Date(captured)
      if (capturedAt.getFullYear() !== year) continue

      const displayBlob = await decodeImage(file)
      const thumbnail = await makeThumbnail(displayBlob)
      const { width, height } = await imageInfo(displayBlob)
      const analysis = await analyzePhoto(thumbnail).catch((error) => {
        console.warn(`${file.name}의 장면 분석을 건너뜁니다.`, error)
        return undefined
      })
      const movie = movies.get(baseName(file.name))
      const id = `${file.name}-${file.size}-${file.lastModified}`
      const automaticSize = analysis && analysis.importance > 0.72 ? 'large' : analysis && analysis.importance < 0.38 ? 'small' : 'medium'
      const photo: Photo = {
        id,
        name: file.name,
        file,
        movie,
        url: URL.createObjectURL(displayBlob),
        thumbUrl: URL.createObjectURL(thumbnail),
        capturedAt: capturedAt.toISOString(),
        width,
        height,
        latitude: metadata?.latitude ?? metadata?.GPSLatitude,
        longitude: metadata?.longitude ?? metadata?.GPSLongitude,
        size: automaticSize,
        layoutWeight: automaticSize === 'large' ? 1.7 : automaticSize === 'small' ? 0.65 : 1,
        isLive: Boolean(movie),
        analysis,
      }
      photos.push(photo)
      await persistPhoto(photo, thumbnail, displayBlob)
    } catch (error) {
      console.warn(`${file.name} 파일을 건너뜁니다.`, error)
    }
  }

  return photos.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))
}

export async function chooseDirectoryFiles(): Promise<File[]> {
  const picker = (window as Window & {
    showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>
  }).showDirectoryPicker
  if (!picker) throw new Error('FALLBACK_INPUT')
  const root = await picker()
  const files: File[] = []

  async function walk(directory: FileSystemDirectoryHandle) {
    for await (const handle of directory.values()) {
      if (handle.kind === 'file') files.push(await handle.getFile())
      else await walk(handle)
    }
  }
  await walk(root)
  return files
}
