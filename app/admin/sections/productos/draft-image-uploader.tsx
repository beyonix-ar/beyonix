"use client"

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  GripVertical,
  ImageIcon,
  Trash2,
  Upload,
} from "lucide-react"

interface DraftImageUploaderProps {
  files: File[]
  onChange: (files: File[]) => void
  emptyMessage?: string
}

interface PreviewImage {
  file: File
  url: string
}

export function DraftImageUploader({
  files,
  onChange,
  emptyMessage = "Carga imagenes antes de crear el producto.",
}: DraftImageUploaderProps) {
  const inputRef =
    useRef<HTMLInputElement>(null)

  const [dragging, setDragging] =
    useState(false)
  const [draggedIndex, setDraggedIndex] =
    useState<number | null>(null)

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

  const moveFile = (
    fromIndex: number,
    toIndex: number
  ) => {
    if (fromIndex === toIndex) {
      return
    }

    const nextFiles = [...files]
    const [file] = nextFiles.splice(fromIndex, 1)
    nextFiles.splice(toIndex, 0, file)
    onChange(nextFiles)
  }

  return (
    <div className="space-y-4">
      <div
        onClick={() =>
          inputRef.current?.click()
        }
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)

          addFiles(
            Array.from(
              event.dataTransfer.files
            )
          )
        }}
        onDragOver={(event) => {
          event.preventDefault()
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
            Arrastra imagenes aca
          </p>

          <p className="mt-1 text-xs text-white/40">
            o hace click para seleccionar
          </p>
        </div>

        <input
          hidden
          multiple
          ref={inputRef}
          type="file"
          accept="image/*"
          aria-label="Seleccionar imagenes"
          title="Seleccionar imagenes"
          onChange={(event) => {
            if (event.target.files) {
              addFiles(
                Array.from(
                  event.target.files
                )
              )
            }

            event.target.value = ""
          }}
        />
      </div>

      {!files.length && (
        <div className="rounded-2xl border border-white/6 bg-black px-5 py-6 text-center">
          <ImageIcon className="mx-auto mb-2 size-7 text-white/15" />

          <p className="text-sm text-white/55">
            {emptyMessage}
          </p>
        </div>
      )}

      {!!files.length && (
        <div className="grid grid-cols-4 gap-3">
          {previews.map((preview, index) => (
            <div
              key={`${preview.file.name}-${preview.file.lastModified}`}
              draggable
              onDragStart={(event) => {
                setDraggedIndex(index)
                event.dataTransfer.effectAllowed = "move"
              }}
              onDragOver={(event) => {
                event.preventDefault()
              }}
              onDrop={(event) => {
                event.preventDefault()

                if (draggedIndex !== null) {
                  moveFile(draggedIndex, index)
                }

                setDraggedIndex(null)
              }}
              onDragEnd={() => setDraggedIndex(null)}
              className="group relative aspect-square cursor-grab overflow-hidden rounded-2xl border border-white/7 bg-black active:cursor-grabbing"
            >
              <img
                alt={preview.file.name}
                src={preview.url}
                className="h-full w-full object-cover"
              />

              <div className="absolute inset-0 flex items-center justify-center bg-black/65 opacity-0 transition-opacity group-hover:opacity-100">
                <span className="absolute left-2 top-2 flex size-7 items-center justify-center rounded-lg border border-white/10 bg-black/70 text-white/60">
                  <GripVertical className="size-4" />
                </span>

                <button
                  type="button"
                  title="Quitar imagen"
                  aria-label={`Quitar imagen ${preview.file.name}`}
                  onClick={() =>
                    removeFile(preview)
                  }
                  className="flex size-9 cursor-pointer items-center justify-center rounded-xl bg-red-500/90 transition-colors hover:bg-red-500"
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
