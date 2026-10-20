import { basename } from 'node:path'
import { unzipSync, type UnzipFileInfo } from 'fflate'
import { sniffImageMimeType } from '../session/attachment-block.js'

export type SharedFileMime =
  | 'image/png'
  | 'image/jpeg'
  | 'image/webp'
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  | 'text/csv'
  | 'text/plain'

const OOXML_CONTENT_TYPES_MAX = 256 * 1024

/** File type declared by bounded content inspection, never by an arbitrary MIME argument. */
export function sniffSharedFile(bytes: Buffer, sourceName: string): SharedFileMime | 'image/gif' | undefined {
  const image = sniffImageMimeType(bytes)
  if (image) return image
  const head6 = bytes.subarray(0, 6).toString('latin1')
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif'
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf'

  const ooxml = sniffOoxml(bytes)
  if (ooxml) return ooxml

  if (bytes.includes(0)) return undefined
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
  return /\.csv$/i.test(sourceName) ? 'text/csv' : 'text/plain'
}

function sniffOoxml(bytes: Buffer): SharedFileMime | undefined {
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) return undefined
  const names = new Set<string>()
  try {
    const extracted = unzipSync(bytes, {
      filter: (info: UnzipFileInfo) => {
        names.add(info.name)
        return info.name === '[Content_Types].xml' && info.originalSize <= OOXML_CONTENT_TYPES_MAX
      }
    })
    const contentTypes = extracted['[Content_Types].xml']
    if (!contentTypes) return undefined
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(contentTypes)
    if (
      hasFolder(names, 'word/') &&
      xml.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')
    )
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    if (
      hasFolder(names, 'ppt/') &&
      xml.includes('application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml')
    )
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    if (
      hasFolder(names, 'xl/') &&
      xml.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml')
    )
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  } catch {
    return undefined
  }
  return undefined
}

function hasFolder(names: Set<string>, folder: string): boolean {
  return [...names].some((name) => name.startsWith(folder) && name.length > folder.length)
}

const EXTENSIONS: Record<SharedFileMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv',
  'text/plain': 'txt'
}

/** A safe basename whose extension agrees with the sniffed bytes. */
export function sharedFileName(name: string, mime: SharedFileMime): string {
  const stem =
    basename(name)
      .replace(/\.[A-Za-z0-9]+$/, '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 200) || 'file'
  return `${stem}.${EXTENSIONS[mime]}`
}
