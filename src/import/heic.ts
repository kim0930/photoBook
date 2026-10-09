interface HeifChannel {
  id: number
  width: number
  height: number
  stride: number
  data: Uint8Array
}

interface HeifImage {
  get_width(): number
  get_height(): number
  display(
    imageData: { data: Uint8ClampedArray; width: number; height: number },
    done: (result: { data: Uint8ClampedArray; width: number; height: number } | null) => void,
  ): void
}

interface HeifDecoder {
  decoder: unknown
  decode(data: Uint8Array): HeifImage[]
}

interface LibHeif {
  HeifDecoder: new () => HeifDecoder
  heif_js_context_get_image_handle(context: unknown, id: number): { code?: number } | undefined
  heif_js_decode_image2(handle: unknown, colorspace: number, chroma: number): {
    code?: number
    image?: unknown
    channels?: HeifChannel[]
  }
  heif_colorspace_RGB: number
  heif_chroma_interleaved_RGBA: number
  heif_channel_interleaved: number
  heif_context_free(context: unknown): void
  heif_image_release(image: unknown): void
  heif_image_handle_release(handle: unknown): void
}

let libheifPromise: Promise<LibHeif> | undefined
let heicLock = Promise.resolve()

function loadLibheif() {
  if (!libheifPromise) {
    libheifPromise = import('libheif-js/wasm-bundle').then((mod) => mod.default as LibHeif)
  }
  return libheifPromise
}

function withHeic<T>(task: () => Promise<T>) {
  const run = heicLock.then(task, task)
  heicLock = run.then(() => undefined, () => undefined)
  return run
}

function boxKind(bytes: Uint8Array, offset: number) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3])
}

function thumbnailItemId(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  function head(offset: number) {
    let length = view.getUint32(offset)
    let start = offset + 8
    if (length === 1) {
      length = Number(view.getBigUint64(offset + 8))
      start += 8
    }
    return { offset, length, start, kind: boxKind(bytes, offset + 4) }
  }
  function children(box: ReturnType<typeof head>, full: boolean) {
    const list: Array<ReturnType<typeof head>> = []
    let offset = box.start + (full ? 4 : 0)
    const end = box.offset + box.length
    while (offset + 8 <= end) {
      const child = head(offset)
      if (child.length < 8 || offset + child.length > end) break
      list.push(child)
      offset += child.length
    }
    return list
  }

  let offset = 0
  let meta: ReturnType<typeof head> | undefined
  while (offset + 8 <= bytes.byteLength) {
    const box = head(offset)
    if (box.length < 8) break
    if (box.kind === 'meta') {
      meta = box
      break
    }
    offset += box.length
  }
  if (!meta) return undefined
  const iref = children(meta, true).find((box) => box.kind === 'iref')
  if (!iref) return undefined
  const version = view.getUint32(iref.start) >>> 24
  const thumbnail = children(iref, true).find((box) => box.kind === 'thmb')
  if (!thumbnail) return undefined
  return version === 0 ? view.getUint16(thumbnail.start) : view.getUint32(thumbnail.start)
}

function rgbaFromChannel(channel: HeifChannel) {
  if (channel.stride === channel.width * 4) return new Uint8ClampedArray(channel.data)
  const pixels = new Uint8ClampedArray(channel.width * channel.height * 4)
  const rowBytes = channel.width * 4
  for (let y = 0; y < channel.height; y += 1) {
    pixels.set(channel.data.subarray(y * channel.stride, y * channel.stride + rowBytes), y * rowBytes)
  }
  return pixels
}

async function bitmapFromHandle(lib: LibHeif, handle: unknown) {
  const decoded = lib.heif_js_decode_image2(handle, lib.heif_colorspace_RGB, lib.heif_chroma_interleaved_RGBA)
  try {
    const channel = decoded.channels?.find((item) => item.id === lib.heif_channel_interleaved)
    if (!channel?.width || !channel.height) return undefined
    return await createImageBitmap(new ImageData(rgbaFromChannel(channel), channel.width, channel.height))
  } finally {
    if (decoded.image) lib.heif_image_release(decoded.image)
  }
}

export async function quickHeicBitmap(file: Blob) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const itemId = thumbnailItemId(bytes)
  if (itemId == null) return undefined
  return withHeic(async () => {
    const lib = await loadLibheif()
    const decoder = new lib.HeifDecoder()
    decoder.decode(bytes)
    try {
      const handle = lib.heif_js_context_get_image_handle(decoder.decoder, itemId)
      if (!handle || handle.code) return undefined
      return await bitmapFromHandle(lib, handle)
    } finally {
      if (decoder.decoder) lib.heif_context_free(decoder.decoder)
    }
  })
}

async function blobFromBitmap(bitmap: ImageBitmap, maxEdge: number, quality: number) {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(bitmap.width * scale)),
    Math.max(1, Math.round(bitmap.height * scale)),
  )
  const context = canvas.getContext('2d')
  if (!context) throw new Error('이미지를 처리할 수 없습니다.')
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  return canvas.convertToBlob({ type: 'image/jpeg', quality })
}

export async function renderHeicDisplay(file: Blob) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  return withHeic(async () => {
    const lib = await loadLibheif()
    const decoder = new lib.HeifDecoder()
    const image = decoder.decode(bytes)[0]
    if (!image) throw new Error('HEIC 이미지를 읽지 못했습니다.')
    const width = image.get_width()
    const height = image.get_height()
    const rgba = new Uint8ClampedArray(width * height * 4)
    await new Promise<void>((resolve, reject) => {
      image.display({ data: rgba, width, height }, (result) => {
        if (result) resolve()
        else reject(new Error('HEIC 이미지를 변환하지 못했습니다.'))
      })
    })
    const bitmap = await createImageBitmap(new ImageData(rgba, width, height))
    try {
      if (decoder.decoder) lib.heif_context_free(decoder.decoder)
      return {
        display: await blobFromBitmap(bitmap, 2560, 0.86),
        thumbnail: await blobFromBitmap(bitmap, 640, 0.82),
      }
    } finally {
      bitmap.close()
    }
  })
}
