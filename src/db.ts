import Dexie, { type EntityTable } from 'dexie'
import type { Chapter, Photo } from './types'

type StoredPhoto = Omit<Photo, 'url' | 'thumbUrl'> & { thumbnail: Blob }

class PhotoBookDatabase extends Dexie {
  photos!: EntityTable<StoredPhoto, 'id'>
  chapters!: EntityTable<Chapter, 'id'>

  constructor() {
    super('yearly-photobook')
    this.version(1).stores({
      photos: 'id, capturedAt, name',
      chapters: 'id, type, month',
    })
  }
}

export const db = new PhotoBookDatabase()

export async function persistPhoto(photo: Photo, thumbnail: Blob, displayBlob: Blob = photo.file) {
  const { url: _url, thumbUrl: _thumbUrl, ...stored } = photo
  await db.photos.put({ ...stored, file: displayBlob, thumbnail })
}

export async function clearLibrary() {
  await db.transaction('rw', db.photos, db.chapters, async () => {
    await db.photos.clear()
    await db.chapters.clear()
  })
}

export async function loadLibrary(): Promise<{ photos: Photo[]; chapters: Chapter[] }> {
  const [storedPhotos, chapters] = await Promise.all([db.photos.toArray(), db.chapters.toArray()])
  const photos = storedPhotos.map(({ thumbnail, ...photo }) => ({
    ...photo,
    url: URL.createObjectURL(photo.selectedFrame ? dataUrlToBlob(photo.selectedFrame) : photo.file),
    thumbUrl: URL.createObjectURL(thumbnail),
  }))
  return { photos, chapters }
}

function dataUrlToBlob(dataUrl: string) {
  const [header, encoded] = dataUrl.split(',')
  const mime = header.match(/data:(.*?);/)?.[1] ?? 'image/jpeg'
  const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0))
  return new Blob([bytes], { type: mime })
}
