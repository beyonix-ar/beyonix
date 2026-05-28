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
        className={`flex h-36 cursor-pointer flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed transition-colors ${
          dragging
            ? "border-beyonix-cyan bg-beyonix-blue/30"
            : "border-white/10 bg-white/2 hover:border-white/20"
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
          title="Seleccionar imágenes"
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
        <div className="rounded-2xl border border-red-500/20 bg-red-500/8 px-4 py-3">
          <p className="text-sm text-red-400">
            {error}
          </p>
        </div>
      )}

      {!uploading &&
        !imagenes.length && (
          <div className="rounded-2xl border border-white/6 bg-white/2 px-5 py-10 text-center">
            <ImageIcon className="mx-auto mb-3 size-8 text-white/15" />

            <p className="text-sm text-white/55">
              No hay imágenes
              cargadas.
            </p>
          </div>
        )}

      {!!imagenes.length && (
        <div className="grid grid-cols-4 gap-3">
          {imagenes.map((img) => (
            <div
              key={img.id}
              className="group relative aspect-square overflow-hidden rounded-2xl border border-white/7 bg-beyonix-surface-3"
            >
              <img
                alt=""
                src={img.url}
                className="h-full w-full object-cover"
              />

              <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/65 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  title="Imagen principal"
                  aria-label="Imagen principal"
                  onClick={() =>
                    setPrincipal(
                      img.url
                    )
                  }
                  className="flex size-9 items-center justify-center rounded-xl bg-amber-500/90 transition-colors hover:bg-amber-500 cursor-pointer"
                >
                  <Star className="size-4 text-white" />
                </button>

                <button
                  type="button"
                  title="Eliminar imagen"
                  aria-label="Eliminar imagen"
                  onClick={() =>
                    deleteImage(
                      img
                    )
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