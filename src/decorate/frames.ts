import type { BookCoverDesign, DecorFrame, FrameTemplateId } from '../types'

export const EMPTY_FRAME: DecorFrame = {
  templateId: 'none',
  color: '#2c2824',
  accentColor: '#c4a574',
  weight: 1.2,
  inset: 2.2,
}

export type FrameTemplate = {
  id: FrameTemplateId
  label: string
  hint: string
  defaults?: Partial<DecorFrame>
}

export const FRAME_TEMPLATES: FrameTemplate[] = [
  { id: 'none', label: '없음', hint: '테두리 없이' },
  { id: 'thin', label: '슬림', hint: '얇은 한 줄', defaults: { color: '#2c2824', weight: 1, inset: 2 } },
  { id: 'double', label: '더블', hint: '이중선 액자', defaults: { color: '#3a342c', weight: 1.4, inset: 2.4 } },
  { id: 'mat', label: '매트', hint: '넓은 여백 액자', defaults: { color: '#5a5248', weight: 1.1, inset: 4.5 } },
  { id: 'gold-line', label: '골드', hint: '골드 라인', defaults: { color: '#c4a574', accentColor: '#8a7048', weight: 1.3, inset: 2.6 } },
  { id: 'polaroid', label: '폴라로이드', hint: '흰 테두리', defaults: { color: '#f7f3ec', accentColor: '#d8d0c4', weight: 2.2, inset: 1.2 } },
  { id: 'film', label: '필름', hint: '필름 가장자리', defaults: { color: '#1d1b19', accentColor: '#f2ebe3', weight: 1.6, inset: 1.5 } },
  { id: 'corner-flourish', label: '코너', hint: '모서리 장식', defaults: { color: '#6b5a45', accentColor: '#c4a574', weight: 1.2, inset: 3 } },
  { id: 'dashed', label: '점선', hint: '손그림 느낌', defaults: { color: '#7a6a55', weight: 1.3, inset: 2.8 } },
  { id: 'ribbon', label: '리본', hint: '부드러운 띠', defaults: { color: '#d9b7a0', accentColor: '#8d5e4a', weight: 1.5, inset: 2.2 } },
  { id: 'custom', label: '직접', hint: '색·굵기·이미지', defaults: { color: '#2c2824', weight: 1.4, inset: 2.4 } },
]

export type CoverTheme = {
  id: string
  label: string
  hint: string
  backgroundColor: string
  textColor: string
  frame?: Partial<DecorFrame>
}

export const COVER_THEMES: CoverTheme[] = [
  {
    id: 'midnight',
    label: '미드나이트',
    hint: '짙은 밤',
    backgroundColor: '#2c2824',
    textColor: '#f6f1e8',
    frame: { templateId: 'thin', color: '#f6f1e8', weight: 1, inset: 3 },
  },
  {
    id: 'ivory',
    label: '아이보리',
    hint: '밝은 앨범',
    backgroundColor: '#f3ece2',
    textColor: '#2c2824',
    frame: { templateId: 'double', color: '#2c2824', weight: 1.2, inset: 3.2 },
  },
  {
    id: 'blush',
    label: '블러시',
    hint: '부드러운 장밋빛',
    backgroundColor: '#e8cfc6',
    textColor: '#4a2f2a',
    frame: { templateId: 'ribbon', color: '#ffffff', accentColor: '#b07a6c', weight: 1.4, inset: 2.8 },
  },
  {
    id: 'forest',
    label: '포레스트',
    hint: '깊은 초록',
    backgroundColor: '#24332b',
    textColor: '#e7efe8',
    frame: { templateId: 'gold-line', color: '#c4a574', weight: 1.2, inset: 3 },
  },
  {
    id: 'ocean',
    label: '오션',
    hint: '차분한 바다',
    backgroundColor: '#1f2f3a',
    textColor: '#e8f1f5',
    frame: { templateId: 'thin', color: '#9ec5d4', weight: 1.1, inset: 3 },
  },
  {
    id: 'kraft',
    label: '크래프트',
    hint: '따뜻한 종이',
    backgroundColor: '#c9a57a',
    textColor: '#2d2116',
    frame: { templateId: 'dashed', color: '#2d2116', weight: 1.3, inset: 3.2 },
  },
  {
    id: 'film-dark',
    label: '필름 다크',
    hint: '시네마틱',
    backgroundColor: '#141312',
    textColor: '#f0e9df',
    frame: { templateId: 'film', color: '#141312', accentColor: '#f0e9df', weight: 1.8, inset: 1.8 },
  },
  {
    id: 'polaroid-cover',
    label: '폴라로이드',
    hint: '흰 여백 표지',
    backgroundColor: '#f7f3ec',
    textColor: '#2c2824',
    frame: { templateId: 'polaroid', color: '#ffffff', accentColor: '#d8d0c4', weight: 2.4, inset: 1.5 },
  },
]

export function frameFromTemplate(templateId: FrameTemplateId, current?: DecorFrame): DecorFrame {
  const template = FRAME_TEMPLATES.find((item) => item.id === templateId)
  return {
    ...EMPTY_FRAME,
    ...current,
    ...template?.defaults,
    templateId,
    customImageDataUrl: templateId === 'custom' ? current?.customImageDataUrl : undefined,
  }
}

export function applyCoverTheme(themeId: string, cover: BookCoverDesign): Partial<BookCoverDesign> {
  const theme = COVER_THEMES.find((item) => item.id === themeId)
  if (!theme) return { themeId: 'custom' }
  return {
    themeId: theme.id,
    backgroundColor: theme.backgroundColor,
    textColor: theme.textColor,
    frame: theme.frame
      ? frameFromTemplate(theme.frame.templateId ?? 'thin', {
          ...EMPTY_FRAME,
          ...cover.frame,
          ...theme.frame,
        })
      : cover.frame,
  }
}

/** 장식용 이미지를 data URL로 줄여 담는다 (최대 약 900px). */
export async function readFrameImage(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('이미지 파일만 넣을 수 있습니다.')
  const bitmap = await createImageBitmap(file)
  try {
    const maxEdge = 900
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('이미지를 처리하지 못했습니다.')
    ctx.drawImage(bitmap, 0, 0, width, height)
    return canvas.toDataURL('image/png')
  } finally {
    bitmap.close()
  }
}
