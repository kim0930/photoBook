export type PhotoSize = 'small' | 'medium' | 'large'
export type SceneType = 'people' | 'landscape' | 'food' | 'animal' | 'architecture' | 'other'

export interface PhotoAnalysis {
  scene: SceneType
  confidence: number
  personCount: number
  importance: number
  sharpness: number
  brightness: number
  dominantColor: string
  focalPoint: { x: number; y: number }
  tags: string[]
}

export interface PhotoCrop {
  zoom: number
  x: number
  y: number
}

export interface PhotoFrame {
  x: number
  y: number
  width: number
  height: number
}

export interface Photo {
  id: string
  name: string
  file: Blob
  movie?: Blob
  url: string
  thumbUrl: string
  capturedAt: string
  width: number
  height: number
  latitude?: number
  longitude?: number
  size: PhotoSize
  layoutWeight?: number
  manuallyPositioned?: boolean
  isLive: boolean
  selectedFrame?: string
  analysis?: PhotoAnalysis
  crop?: PhotoCrop
  freeFrame?: PhotoFrame
  framePriority?: number
}

export interface Chapter {
  id: string
  type: 'month' | 'trip'
  title: string
  photoIds: string[]
  month?: number
  note: string
  coverPhotoId?: string
}

export interface BookPage {
  id: string
  chapterId: string
  type: 'intro' | 'photos' | 'map'
  photoIds: string[]
  layoutId?: string
}

export interface BookSize {
  name: string
  widthMm: number
  heightMm: number
}

export interface ImportProgress {
  current: number
  total: number
  label: string
}
