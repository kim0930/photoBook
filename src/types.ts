export type PhotoSize = 'small' | 'medium' | 'large'
export type SceneType = 'people' | 'landscape' | 'food' | 'animal' | 'architecture' | 'other'

export type ExcludeReason = 'blur' | 'screenshot' | 'document' | 'duplicate' | 'lowres'
export type HoldReason = 'budget' | 'date' | 'face'

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
  detailed?: boolean
  saturation?: number
  edgeDensity?: number
  documentCandidate?: boolean
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
  layoutLocked?: boolean
  isLive: boolean
  omitted?: boolean
  quality?: number
  excludeReason?: ExcludeReason
  holdReason?: HoldReason
  burstId?: string
  burstBest?: boolean
  eventId?: string
  thumbHash?: string
  forcedIn?: boolean
  inBook?: boolean
  ocrText?: string
  faceQuality?: number
  selectedFrame?: string
  analysis?: PhotoAnalysis
  crop?: PhotoCrop
  rotation?: 0 | 90 | 180 | 270
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
  coverManual?: boolean
  skipIntro?: boolean
  skipMap?: boolean
}

export interface HiddenRange {
  id: string
  start: string
  end: string
}

export interface FaceGroup {
  id: string
  name: string
  hidden: boolean
  descriptor: number[]
  photoIds: string[]
  coverPhotoId?: string
}

export interface CurationSettings {
  faceGroupsEnabled: boolean
  hiddenRanges: HiddenRange[]
  signalsVersion?: number
}

export interface PageCaption {
  date?: string
  place?: string
  page?: string
}

export type FlowAspect = 'locked' | 'free'

export interface BookPage {
  id: string
  chapterId: string
  type: 'intro' | 'photos' | 'map'
  photoIds: string[]
  layoutId?: string
  flowAspect?: FlowAspect
}

export type PageNoteKind = 'text' | 'phrase' | 'memo'
export type PageNoteColor = 'yellow' | 'pink' | 'blue' | 'cream'
export type PageNoteFont = 'sans' | 'serif' | 'pen'

export interface PageNote {
  id: string
  kind: PageNoteKind
  text: string
  x: number
  y: number
  color: PageNoteColor
  font?: PageNoteFont
  fontSize?: number
  textColor?: string
  backgroundColor?: string
  backgroundAlpha?: number
  width?: number
  height?: number
}

export interface DrawStroke {
  id: string
  color: string
  size: number
  points: { x: number; y: number }[]
}

export interface BookCoverDesign {
  title: string
  subtitle: string
  spineText: string
  backText: string
  backgroundColor: string
  textColor: string
  frontPhotoId?: string
  backPhotoId?: string
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
