"use client"

import { useRef } from "react"

import {
  ImageIcon,
  Loader2,
  Star,
  Trash2,
  Upload,
} from "lucide-react"

import { useImageUploader } from "./use-image-uploader"
import { TransparencyAwareImage } from "@/components/transparency-aware-image"

interface ImageUploaderProps {
  productoId: number
}

export function ImageUploader({
  productoId,
}: ImageUploaderProps) {
  const inputRef =
    useRef<HTMLInputElement>(null)

  const {
    error,
    dragging,
    uploading,
    imagenes,

    setDragging,

    uploadFiles,

    deleteImage,

    setPrincipal,
  } = useImageUploader({
    productoId,
  })

  return (
    <div className="space-y-4">
      <div
        onClick={() =>
          inputRef.current?.click()
        }
        onDrop={(e) => {
          e.preventDefault()

          setDragging(false)

          uploadFiles(
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
        className={`admin-ds-upload-zone admin-ds-upload-zone-large flex cursor-pointer flex-col items-center justify-center gap-3 border border-dashed transition-colors ${
          dragging ? "admin-ds-upload-zone-active" : ""
        }`}
      >
        {uploading ? (
          <Loader2 className="size-7 animate-spin text-white/50" />
        ) : (
          <>
            <Upload className="size-6 text-white/25" />

            <div className="text-center">
              <p className="text-sm font-medium text-white/75">
                Arrastrá imágenes acá
              </p>

              <p className="mt-1 text-xs text-white/40">
                o hacé click para
                seleccionar
              </p>

              <p className="mt-2 text-10px font-semibold uppercase tracking-widest text-beyonix-cyan/70">
                PNG · 1:1 · 2000 × 2000 px
              </p>
            </div>
          </>
        )}

        <input
          hidden
          multiple
          ref={inputRef}
          type="file"
          accept="image/*"
          aria-label="Seleccionar imágenes"
          onChange={(e) =>
            e.target.files &&
            uploadFiles(
              Array.from(
                e.target.files
              )
            )
          }
        />
      </div>

      {error && (
        <div className="admin-ds-card admin-ds-tone-danger px-4 py-3">
          <p className="text-sm text-red-400">
            {error}
          </p>
        </div>
      )}

      {!uploading &&
        !imagenes.length && (
          <div className="admin-ds-card px-5 py-10 text-center">
            <ImageIcon className="mx-auto mb-3 size-8 text-white/15" />

            <p className="text-sm text-white/55">
              No hay imágenes
              cargadas.
            </p>
          </div>
        )}

      {!!imagenes.length && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
          {imagenes.map((img) => (
            <div
              key={img.id}
              className="admin-ds-media-tile group relative aspect-square overflow-hidden p-1.5 transition-colors"
            >
              <TransparencyAwareImage
                alt=""
                src={img.url}
                className="h-full w-full rounded-xl object-contain"
              />

              <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/65 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  aria-label="Imagen principal"
                  onClick={() =>
                    setPrincipal(
                      img.url
                    )
                  }
                  className="admin-ds-icon-action flex size-9 cursor-pointer items-center justify-center transition-colors"
                >
                  <Star className="size-4 text-white" />
                </button>

                <button
                  type="button"
                  aria-label="Eliminar imagen"
                  onClick={() =>
                    deleteImage(
                      img
                    )
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
