import type { BookSize } from '../types'

export const BOOK_SIZES: BookSize[] = [
  { name: 'A4', widthMm: 210, heightMm: 297 },
  { name: 'A5', widthMm: 148, heightMm: 210 },
  { name: 'B5', widthMm: 176, heightMm: 250 },
  { name: 'Letter', widthMm: 216, heightMm: 279 },
  { name: '정사각 20', widthMm: 200, heightMm: 200 },
  { name: '정사각 25', widthMm: 250, heightMm: 250 },
]

export const MAX_PAGES = 50
