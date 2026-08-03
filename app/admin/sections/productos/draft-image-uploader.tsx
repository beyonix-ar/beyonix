"use client"

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  GripVertical,
  Trash2,
  Upload,
} from "lucide-react"
import { TransparencyAwareImage } from "@/components/transparency-aware-image"

interface DraftImageUploaderProps {
  files: File[]
  onChange: (files: File[]) => void
  emptyMessage?: string
  compact?: boolean
  maxFiles?: number
}

interface PreviewImage {
  file: File
  url: string
}

export function DraftImageUploader({
  files,
  onChange,
  emptyMessage = "Cargá imágenes antes de crear el producto.",
  compact = false,
  maxFiles,
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

    const availableSlots = maxFiles == null
      ? validFiles.length
      : Math.max(0, maxFiles - files.length)

    if (!availableSlots) {
      return
    }

    onChange([...files, ...validFiles.slice(0, availableSlots)])
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
    <div className={compact ? "space-y-2" : "space-y-2.5"}>
      <div
        onClick={() => {
          if (maxFiles == null || files.length < maxFiles) {
            inputRef.current?.click()
          }
        }}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)

          if (maxFiles != null && files.length >= maxFiles) {
            return
          }

          addFiles(
            Array.from(
              event.dataTransfer.files
            )
          )
        }}
        onDragOver={(event) => {
          event.preventDefault()
          if (maxFiles == null || files.length < maxFiles) {
            setDragging(true)
          }
        }}
        onDragLeave={() =>
          setDragging(false)
        }
        aria-disabled={maxFiles != null && files.length >= maxFiles}
        className={`admin-ds-upload-zone admin-ds-upload-zone-compact flex items-center border border-dashed transition-colors ${
          maxFiles != null && files.length >= maxFiles ? "cursor-not-allowed opacity-55" : "cursor-pointer"
        } ${
          compact
            ? "min-h-14 w-full flex-row justify-start gap-2.5 px-3 py-2 sm:max-w-72"
            : "flex-col justify-center gap-1.5"
        } ${
          dragging ? "admin-ds-upload-zone-active" : ""
        }`}
      >
        <Upload className={compact ? "size-4 text-white/35" : "size-6 text-white/25"} />

        <div className={compact ? "min-w-0 text-left" : "text-center"}>
          <p className={compact ? "text-xs font-bold text-white/75" : "text-sm font-medium text-white/75"}>
            {maxFiles != null && files.length >= maxFiles
              ? `Máximo ${maxFiles} imágenes`
              : compact
                ? "Agregar imágenes"
                : "Arrastrá imágenes acá"}
          </p>

          <p className="mt-0.5 line-clamp-1 text-10px text-white/40">
            {maxFiles != null
              ? `${files.length} de ${maxFiles} imágenes`
              : files.length
                ? "Agregá más archivos"
                : emptyMessage}
          </p>

          {!compact && (
            <p className="mt-1 text-10px font-semibold uppercase tracking-widest text-beyonix-cyan/70">
              PNG · 1:1 · 2000 × 2000 px
            </p>
          )}
        </div>

        <input
          hidden
          multiple
          ref={inputRef}
          type="file"
          accept="image/*"
          aria-label="Seleccionar imágenes"
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

      {!!files.length && (
        <div className={compact ? "grid grid-cols-3 gap-2" : "grid grid-cols-3 gap-2 sm:grid-cols-4"}>
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
              className={`admin-ds-media-tile group relative aspect-square cursor-grab overflow-hidden p-1 transition-colors active:cursor-grabbing ${
                compact ? "w-full" : ""
              }`}
            >
              <TransparencyAwareImage
                alt={preview.file.name}
                src={preview.url}
                className="h-full w-full rounded-xl object-contain"
              />

              {index === 0 && (
                <span className={`absolute rounded-full border border-beyonix-sky/25 bg-beyonix-blue/80 font-semibold uppercase tracking-wider text-beyonix-sky backdrop-blur-sm ${
                  compact ? "left-1.5 top-1.5 px-1.5 py-0.5 text-8px" : "left-2.5 top-2.5 px-2 py-1 text-9px"
                }`}>
                  Principal
                </span>
              )}

              <div className="absolute inset-0 flex items-center justify-center bg-black/65 opacity-0 transition-opacity group-hover:opacity-100">
                <span className="admin-ds-icon-action absolute left-2 top-2 flex size-7 items-center justify-center text-white/60">
                  <GripVertical className="size-4" />
                </span>

                <button
                  type="button"
                  aria-label={`Quitar imagen ${preview.file.name}`}
                  onClick={() =>
                    removeFile(preview)
                  }
                  className="admin-ds-icon-action admin-ds-icon-action-danger flex size-9 cursor-pointer items-center justify-center transition-colors"
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
