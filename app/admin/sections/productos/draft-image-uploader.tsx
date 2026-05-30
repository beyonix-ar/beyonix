"use client"

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  ImageIcon,
  Trash2,
  Upload,
} from "lucide-react"

interface DraftImageUploaderProps {
  files: File[]
  onChange: (files: File[]) => void
}

interface PreviewImage {
  file: File
  url: string
}

export function DraftImageUploader({
  files,
  onChange,
}: DraftImageUploaderProps) {
  const inputRef =
    useRef<HTMLInputElement>(null)

  const [dragging, setDragging] =
    useState(false)

  const previews = useMemo(
    () =>
      files.map((file) => ({
        file,
        url: URL.createObjectURL(file),
      })),
    [files]
  )

  useEffect(() => {
    return () => {
      previews.forEach((preview) =>
        URL.revokeObjectURL(preview.url)
      )
    }
  }, [previews])

  const addFiles = (nextFiles: File[]) => {
    const validFiles = nextFiles.filter((file) =>
      file.type.startsWith("image/")
    )

    if (!validFiles.length) {
      return
    }

    onChange([...files, ...validFiles])
  }

  const removeFile = (
    image: PreviewImage
  ) => {
    onChange(
      files.filter(
        (file) => file !== image.file
      )
    )
  }

  return (
    <div className="space-y-4">
      <div
        onClick={() =>
          inputRef.current?.click()
        }
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)

          addFiles(
            Array.from(
              e.dataTransfer.files
            )
          )
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() =>
          setDragging(false)
        }
        className={`flex h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed transition-colors ${
          dragging
            ? "border-blue-400 bg-sky-950/30"
            : "border-white/10 bg-black hover:border-white/20"
        }`}
      >
        <Upload className="size-6 text-white/25" />

        <div className="text-center">
          <p className="text-sm font-medium text-white/75">
            Arrastrá imágenes acá
          </p>

          <p className="mt-1 text-xs text-white/40">
            o hacé click para seleccionar
          </p>
        </div>

        <input
          hidden
          multiple
          ref={inputRef}
          type="file"
          accept="image/*"
          aria-label="Seleccionar imágenes"
          title="Seleccionar imágenes"
          onChange={(e) => {
            if (e.target.files) {
              addFiles(
                Array.from(
                  e.target.files
                )
              )
            }

            e.target.value = ""
          }}
        />
      </div>

      {!files.length && (
        <div className="rounded-2xl border border-white/6 bg-black px-5 py-6 text-center">
          <ImageIcon className="mx-auto mb-2 size-7 text-white/15" />

          <p className="text-sm text-white/55">
            Cargá imágenes antes de crear el producto.
          </p>
        </div>
      )}

      {!!files.length && (
        <div className="grid grid-cols-4 gap-3">
          {previews.map((preview) => (
            <div
              key={`${preview.file.name}-${preview.file.lastModified}`}
              className="group relative aspect-square overflow-hidden rounded-2xl border border-white/7 bg-black"
            >
              <img
                alt={preview.file.name}
                src={preview.url}
                className="h-full w-full object-cover"
              />

              <div className="absolute inset-0 flex items-center justify-center bg-black/65 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  title="Quitar imagen"
                  aria-label={`Quitar imagen ${preview.file.name}`}
                  onClick={() =>
                    removeFile(preview)
                  }
                  className="flex size-9 items-center justify-center rounded-xl bg-red-500/90 transition-colors hover:bg-red-500 cursor-pointer"
                >
                  <Trash2 className="size-4 text-white" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
