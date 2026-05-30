"use client"

import {
  useEffect,
  useMemo,
  useState,
} from "react"

import type {
  SupabaseCategoria,
  SupabaseProducto,
} from "@/lib/supabase/types"

import type {
  DraftProductoVariante,
} from "./types"

import {
  uploadProductoImages,
} from "@/lib/supabase/queries/producto-imagenes"

import {
  createProductoVariante,
} from "@/lib/supabase/queries/producto-variantes"

import {
  createProducto,
  deleteProducto,
  getCategorias,
  updateProducto,
} from "@/lib/supabase/queries/productos"

import { slugify } from "./helpers"

interface Props {
  producto?: SupabaseProducto | null
  onSaved: () => void
}

interface SubmitOptions {
  draftVariants?: DraftProductoVariante[]
  onDraftSaved?: () => void
}

type SupabaseLikeError = {
  message?: string
  details?: string
  hint?: string
  code?: string
}

const getErrorMessage = (
  err: unknown
) => {
  if (
    err &&
    typeof err === "object"
  ) {
    const supabaseError =
      err as SupabaseLikeError

    const parts = [
      supabaseError.message,
      supabaseError.details,
      supabaseError.hint,
      supabaseError.code
        ? `Código: ${supabaseError.code}`
        : null,
    ].filter(Boolean)

    if (parts.length) {
      return parts.join(" | ")
    }
  }

  if (err instanceof Error) {
    return err.message
  }

  return "Error desconocido al guardar el producto."
}

export function useProductoForm({
  producto,
  onSaved,
}: Props) {
  const [categorias, setCategorias] =
    useState<SupabaseCategoria[]>([])

  const [saving, setSaving] =
    useState(false)

  const [error, setError] =
    useState("")

  const [success, setSuccess] =
    useState("")

  const [savedId, setSavedId] =
    useState<number | null>(
      producto?.id ?? null
    )

  const [form, setForm] = useState({
    nombre: producto?.nombre ?? "",
    slug: producto?.slug ?? "",
    descripcion:
      producto?.descripcion ?? "",
    precio:
      String(producto?.precio ?? ""),
    precio_anterior: String(
      producto?.precio_anterior ?? ""
    ),
    stock: String(
      producto?.stock ?? 0
    ),
    categoria_id: String(
      producto?.categoria_id ?? ""
    ),
    destacado:
      producto?.destacado ?? false,
    activo:
      producto?.activo ?? false,
  })

  useEffect(() => {
    getCategorias()
      .then(setCategorias)
      .catch((err) => {
        console.error(
          "Error cargando categorías:",
          err
        )
      })
  }, [])

  const setField = (
    key: keyof typeof form,
    value:
      | string
      | boolean
  ) => {
    setForm((prev) => ({
      ...prev,
      [key]: value,
    }))
  }

  const handleNombreChange = (
    value: string
  ) => {
    setField("nombre", value)

    if (!producto) {
      setField(
        "slug",
        slugify(value)
      )
    }
  }

  const payload = useMemo(() => {
    const precio =
      Number(form.precio)

    const precioAnterior =
      form.precio_anterior
        ? Number(
            form.precio_anterior
          )
        : null

    return {
      nombre:
        form.nombre.trim(),

      slug:
        form.slug.trim() ||
        slugify(form.nombre),

      descripcion:
        form.descripcion.trim() ||
        null,

      precio,

      precio_anterior:
        precioAnterior,

      descuento:
        precioAnterior &&
        precioAnterior > precio
          ? Math.round(
              ((precioAnterior -
                precio) /
                precioAnterior) *
                100
            )
          : null,

      stock:
        Number(form.stock) || 0,

      categoria_id:
        form.categoria_id
          ? Number(
              form.categoria_id
            )
          : null,

      destacado:
        form.destacado,

      activo:
        form.activo,
    }
  }, [form])

  const submit = async ({
    draftVariants = [],
    onDraftSaved,
  }: SubmitOptions = {}) => {
    setError("")
    setSuccess("")

    if (!form.nombre.trim()) {
      setError(
        "El nombre es obligatorio."
      )

      return
    }

    if (
      !Number.isFinite(payload.precio) ||
      payload.precio <= 0
    ) {
      setError(
        "El precio es obligatorio."
      )

      return
    }

    if (!payload.slug) {
      setError(
        "El slug es obligatorio."
      )

      return
    }

    if (
      !producto &&
      !savedId &&
      !draftVariants.length
    ) {
      setError(
        "Agregá al menos una variante con su stock."
      )

      return
    }

    let createdProductId: number | null =
      null

    try {
      setSaving(true)

      const variantsStock =
        draftVariants.reduce(
          (total, variant) =>
            total +
            (Number(
              variant.stock
            ) || 0),
          0
        )

      const nextPayload = {
        ...payload,
        stock:
          draftVariants.length
            ? variantsStock
            : payload.stock,
      }

      if (producto) {
        await updateProducto(
          producto.id,
          nextPayload
        )

        setSuccess(
          "Producto actualizado correctamente."
        )
        onSaved()

        return
      }

      if (savedId) {
        await updateProducto(
          savedId,
          nextPayload
        )

        setSuccess(
          "Producto actualizado correctamente."
        )
        onSaved()

        return
      }

      const created =
        await createProducto(
          nextPayload
        )

      createdProductId = created.id

      let imageOrder = 0
      let principalImage: string | null =
        null

      for (const [
        index,
        variant,
      ] of draftVariants.entries()) {
        const urls =
          variant.imagenes.length
            ? await uploadProductoImages(
                created.id,
                variant.imagenes,
                imageOrder
              )
            : []

        imageOrder += urls.length

        if (!principalImage && urls[0]) {
          principalImage = urls[0]
        }

        await createProductoVariante({
          producto_id:
            created.id,
          nombre:
            variant.nombre.trim(),
          color_hex:
            variant.color_hex,
          stock:
            Number(
              variant.stock
            ) || 0,
          imagenes: urls,
          activo: true,
          orden: index + 1,
        })
      }

      if (principalImage) {
        await updateProducto(
          created.id,
          {
            imagen_principal:
              principalImage,
          }
        )
      }

      setSavedId(created.id)
      onDraftSaved?.()
      setSuccess(
        "Producto creado correctamente."
      )
      onSaved()
    } catch (err) {
      const message =
        getErrorMessage(err)

      console.error(
        "Error guardando producto:",
        err
      )

      if (
        createdProductId &&
        !savedId &&
        !producto
      ) {
        try {
          await deleteProducto(
            createdProductId
          )
        } catch (rollbackErr) {
          console.error(
            "No se pudo revertir el producto creado:",
            rollbackErr
          )
        }
      }

      setError(
        `Error guardando producto: ${message}`
      )
    } finally {
      setSaving(false)
    }
  }

  return {
    form,
    error,
    success,
    saving,
    savedId,
    categorias,

    setField,

    submit,

    handleNombreChange,
  }
}
