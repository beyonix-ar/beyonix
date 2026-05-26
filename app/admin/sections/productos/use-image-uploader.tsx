"use client"

import {
  useCallback,
  useEffect,
  useState,
} from "react"

import { supabase } from "@/lib/supabase/client"

import type {
  SupabaseImagenProducto,
} from "@/lib/supabase/types"

interface Props {
  productoId: number
}

const BUCKET =
  "imagenes-productos"

export function useImageUploader({
  productoId,
}: Props) {
  const [imagenes, setImagenes] =
    useState<
      SupabaseImagenProducto[]
    >([])

  const [uploading, setUploading] =
    useState(false)

  const [dragging, setDragging] =
    useState(false)

  const [error, setError] =
    useState("")

  const loadImages =
    useCallback(async () => {
      const { data, error } =
        await supabase
          .from(
            "imagenes_producto"
          )
          .select("*")
          .eq(
            "producto_id",
            productoId
          )
          .order("orden")

      if (error) {
        setError(
          "Error cargando imágenes."
        )

        return
      }

      setImagenes(data || [])
    }, [productoId])

  useEffect(() => {
    loadImages()
  }, [loadImages])

  const getFilePath = (
    file: File
  ) => {
    const ext =
      file.name
        .split(".")
        .pop()

    return `productos/${productoId}/${crypto.randomUUID()}.${ext}`
  }

  const uploadSingleFile =
    async (
      file: File,
      orden: number
    ) => {
      const path =
        getFilePath(file)

      const {
        data,
        error: uploadError,
      } =
        await supabase.storage
          .from(BUCKET)
          .upload(path, file)

      if (uploadError) {
        throw uploadError
      }

      const {
        data: {
          publicUrl,
        },
      } =
        supabase.storage
          .from(BUCKET)
          .getPublicUrl(
            data.path
          )

      const {
        error: dbError,
      } = await supabase
        .from(
          "imagenes_producto"
        )
        .insert({
          producto_id:
            productoId,

          url: publicUrl,

          orden,
        })

      if (dbError) {
        throw dbError
      }
    }

  const uploadFiles =
    async (files: File[]) => {
      const validFiles =
        files.filter((file) =>
          file.type.startsWith(
            "image/"
          )
        )

      if (!validFiles.length) {
        setError(
          "Solo se aceptan imágenes."
        )

        return
      }

      try {
        setUploading(true)

        setError("")

        const maxOrden =
          imagenes.length
            ? Math.max(
                ...imagenes.map(
                  (img) =>
                    img.orden
                )
              )
            : 0

        await Promise.all(
          validFiles.map(
            (
              file,
              index
            ) =>
              uploadSingleFile(
                file,
                maxOrden +
                  index +
                  1
              )
          )
        )

        await loadImages()
      } catch (err) {
        console.error(err)

        setError(
          "Error subiendo imágenes."
        )
      } finally {
        setUploading(false)
      }
    }

  const deleteImage =
    async (
      image: SupabaseImagenProducto
    ) => {
      try {
        const path =
          image.url.split(
            `/${BUCKET}/`
          )[1]

        await Promise.all([
          supabase
            .from(
              "imagenes_producto"
            )
            .delete()
            .eq("id", image.id),

          path
            ? supabase.storage
                .from(BUCKET)
                .remove([path])
            : Promise.resolve(),
        ])

        loadImages()
      } catch (err) {
        console.error(err)

        setError(
          "Error eliminando imagen."
        )
      }
    }

  const setPrincipal =
    async (url: string) => {
      try {
        await supabase
          .from("productos")
          .update({
            imagen_principal:
              url,
          })
          .eq("id", productoId)
      } catch (err) {
        console.error(err)

        setError(
          "Error actualizando imagen principal."
        )
      }
    }

  return {
    error,
    dragging,
    uploading,
    imagenes,

    setDragging,

    uploadFiles,

    deleteImage,

    setPrincipal,
  }
}