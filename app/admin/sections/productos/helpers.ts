// ─────────────────────────────────────────────────────────────────────────────
// Slugify
// ─────────────────────────────────────────────────────────────────────────────

import { SITE_SETTINGS } from "@/config/site-settings"

export function slugify(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
}

// ─────────────────────────────────────────────────────────────────────────────
// Format ARS
// ─────────────────────────────────────────────────────────────────────────────

export function formatPrice(
  value: number
) {
  return value.toLocaleString(
    "es-AR",
    {
      style: "currency",
      currency: "ARS",
      maximumFractionDigits: 0,
    }
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Calculate discount
// ─────────────────────────────────────────────────────────────────────────────

export function calculateDiscount(
  precio: number,
  precioAnterior?: number | null
) {
  if (
    !precioAnterior ||
    precioAnterior <= precio
  ) {
    return null
  }

  return Math.round(
    ((precioAnterior - precio) /
      precioAnterior) *
      100
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Stock color
// ─────────────────────────────────────────────────────────────────────────────

export function getStockColor(
  stock: number
) {
  if (stock <= 0) {
    return "text-red-400"
  }

  if (stock <= SITE_SETTINGS.stock.criticalStockThreshold) {
    return "text-red-400"
  }

  if (stock <= SITE_SETTINGS.stock.lowStockThreshold) {
    return "text-amber-400"
  }

  return "text-green-400"
}

// ─────────────────────────────────────────────────────────────────────────────
// Stock label
// ─────────────────────────────────────────────────────────────────────────────

export function getStockLabel(
  stock: number
) {
  if (stock <= 0) {
    return "Sin stock"
  }

  if (stock <= SITE_SETTINGS.stock.criticalStockThreshold) {
    return "Stock crítico"
  }

  if (stock <= SITE_SETTINGS.stock.lowStockThreshold) {
    return "Stock bajo"
  }

  return "En stock"
}

// ─────────────────────────────────────────────────────────────────────────────
// Generate image path
// ─────────────────────────────────────────────────────────────────────────────

export function generateImagePath(
  productoId: number,
  fileName: string
) {
  const ext =
    fileName.split(".").pop()

  return `productos/${productoId}/${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.${ext}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Validate image
// ─────────────────────────────────────────────────────────────────────────────

export function isValidImage(
  file: File
) {
  return file.type.startsWith(
    "image/"
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Format date
// ─────────────────────────────────────────────────────────────────────────────

export function formatDate(
  date: string
) {
  return new Date(
    date
  ).toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  })
}
