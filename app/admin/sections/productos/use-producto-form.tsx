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

import {
  createProducto,
  getCategorias,
  updateProducto,
} from "@/lib/supabase/queries/productos"

import { slugify } from "./helpers"

interface Props {
  producto?: SupabaseProducto | null
  onSaved: () => void
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
      producto?.activo ?? true,
  })

  useEffect(() => {
    getCategorias().then(
      setCategorias
    )
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

  const submit = async () => {
    setError("")

    if (!form.nombre.trim()) {
      setError(
        "El nombre es obligatorio."
      )

      return
    }

    if (!payload.precio) {
      setError(
        "El precio es obligatorio."
      )

      return
    }

    try {
      setSaving(true)

      if (producto) {
        await updateProducto(
          producto.id,
          payload
        )
      } else {
        const created =
          await createProducto(
            payload
          )

        setSavedId(created.id)
      }

      onSaved()
    } catch (err) {
      console.error(err)

      setError(
        "Error guardando producto."
      )
    } finally {
      setSaving(false)
    }
  }

  return {
    form,
    error,
    saving,
    savedId,
    categorias,

    setField,

    submit,

    handleNombreChange,
  }
}