interface ZipEntry {
  document: () => Promise<{ name: string; bytes: Uint8Array }>
}

function crc32(bytes: Uint8Array) {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
    }
  }
  return (value ^ 0xffffffff) >>> 0
}

function localHeader(name: Uint8Array, size: number, crc: number) {
  const bytes = new Uint8Array(30 + name.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x04034b50, true)
  view.setUint16(4, 20, true)
  view.setUint32(14, crc, true)
  view.setUint32(18, size, true)
  view.setUint32(22, size, true)
  view.setUint16(26, name.length, true)
  bytes.set(name, 30)
  return bytes
}

function centralHeader(name: Uint8Array, size: number, crc: number, offset: number) {
  const bytes = new Uint8Array(46 + name.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x02014b50, true)
  view.setUint16(4, 20, true)
  view.setUint16(6, 20, true)
  view.setUint32(16, crc, true)
  view.setUint32(20, size, true)
  view.setUint32(24, size, true)
  view.setUint16(28, name.length, true)
  view.setUint32(42, offset, true)
  bytes.set(name, 46)
  return bytes
}

function endRecord(count: number, directorySize: number, directoryOffset: number) {
  const bytes = new Uint8Array(22)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x06054b50, true)
  view.setUint16(8, count, true)
  view.setUint16(10, count, true)
  view.setUint32(12, directorySize, true)
  view.setUint32(16, directoryOffset, true)
  return bytes
}

/** ZIP sin recomprimir PDFs: sólo mantiene en memoria un PDF y el directorio. */
export function createFiscalZipStream(entries: ZipEntry[], signal?: AbortSignal) {
  const encoder = new TextEncoder()
  const directory: Uint8Array[] = []
  let offset = 0
  let index = 0

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (signal?.aborted) {
        controller.error(new Error("Descarga cancelada."))
        return
      }
      try {
        if (index < entries.length) {
          const document = await entries[index].document()
          const name = encoder.encode(document.name)
          if (!/^[A-Za-z0-9._-]+\.pdf$/.test(document.name) || name.length > 255) {
            throw new Error("Nombre de PDF inválido.")
          }
          const pdf = document.bytes
          if (pdf.byteLength > 0xffffffff || offset + pdf.byteLength + 30 + name.length > 0xffffffff) {
            throw new Error("ZIP demasiado grande.")
          }
          const crc = crc32(pdf)
          const header = localHeader(name, pdf.byteLength, crc)
          directory.push(centralHeader(name, pdf.byteLength, crc, offset))
          offset += header.byteLength + pdf.byteLength
          index += 1
          controller.enqueue(header)
          controller.enqueue(pdf)
          return
        }

        const directoryOffset = offset
        for (const record of directory) {
          controller.enqueue(record)
          offset += record.byteLength
        }
        controller.enqueue(endRecord(directory.length, offset - directoryOffset, directoryOffset))
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })
}
