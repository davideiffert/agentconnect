import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { sharedFileName, sniffSharedFile } from '../src/files/sniff.js'

const CONTENT_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'
} as const

function ooxml(kind: keyof typeof CONTENT_TYPES): Buffer {
  const folder = kind === 'docx' ? 'word' : kind === 'pptx' ? 'ppt' : 'xl'
  return Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8(`<Types><Override ContentType="${CONTENT_TYPES[kind]}"/></Types>`),
      [`${folder}/document.xml`]: strToU8('<root/>')
    })
  )
}

describe('sniffSharedFile', () => {
  it('keeps existing image sniffing unchanged', () => {
    expect(sniffSharedFile(Buffer.from('89504e470d0a1a0a', 'hex'), 'wrong.bin')).toBe('image/png')
    expect(sniffSharedFile(Buffer.from([0xff, 0xd8, 0xff]), 'wrong.bin')).toBe('image/jpeg')
    expect(sniffSharedFile(Buffer.from('RIFF\0\0\0\0WEBP'), 'wrong.bin')).toBe('image/webp')
    expect(sniffSharedFile(Buffer.from('GIF89a......'), 'wrong.bin')).toBe('image/gif')
  })

  it('sniffs PDF and each OOXML document family from content', () => {
    expect(sniffSharedFile(Buffer.from('%PDF-1.7\n'), 'wrong.docx')).toBe('application/pdf')
    expect(sniffSharedFile(ooxml('docx'), 'wrong.bin')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
    expect(sniffSharedFile(ooxml('pptx'), 'wrong.bin')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    )
    expect(sniffSharedFile(ooxml('xlsx'), 'wrong.bin')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
  })

  it('requires both OOXML content types and the matching folder', () => {
    const missingFolder = Buffer.from(
      zipSync({ '[Content_Types].xml': strToU8(`<Types>${CONTENT_TYPES.docx}</Types>`) })
    )
    expect(sniffSharedFile(missingFolder, 'wrong.bin')).toBeUndefined()
  })

  it('accepts UTF-8 text, uses the source extension only to distinguish CSV, and refuses binary', () => {
    expect(sniffSharedFile(Buffer.from('name,count\nalpha,2\n'), 'report.csv')).toBe('text/csv')
    expect(sniffSharedFile(Buffer.from('hello, world\n'), 'note.md')).toBe('text/plain')
    expect(sniffSharedFile(Buffer.from([0x61, 0, 0x62]), 'bad.txt')).toBeUndefined()
    expect(sniffSharedFile(Buffer.from([0xc3, 0x28]), 'bad.txt')).toBeUndefined()
  })

  it('normalizes the extension to the sniffed type', () => {
    expect(sharedFileName('../Quarterly Plan.exe', 'application/pdf')).toBe('Quarterly Plan.pdf')
    expect(sharedFileName('chart.jpeg', 'image/jpeg')).toBe('chart.jpg')
  })
})
