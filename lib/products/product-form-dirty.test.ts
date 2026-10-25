import assert from "node:assert/strict"
import test from "node:test"

import {
  hasProductFormChanges,
  hasVariantStateChanges,
} from "../../app/admin/sections/productos/product-form-dirty.ts"
import type { ProductoFormState } from "../../app/admin/sections/productos/types.ts"
import type { SupabaseProductoVariante } from "../supabase/types.ts"

const saved: ProductoFormState = {
  nombre: "AURICULAR INALÁMBRICO MALIBU",
  sku: "AUMN01",
  slug: "auricular-inalambrico-malibu",
  descripcion: "<p>Sonido envolvente</p>",
  video_url: "",
  precio: "20000",
  precio_anterior: "",
  pricingMode: "manual",
  targetMarginPercent: "",
  categoria_id: "3",
  destacado: false,
  activo: false,
  peso_empaquetado_kg: "0,3",
  alto_paquete_cm: "8",
  ancho_paquete_cm: "18",
  largo_paquete_cm: "20",
}

test("sin ediciones la ficha no tiene cambios sin guardar", () => {
  assert.equal(hasProductFormChanges({ ...saved }, saved), false)
})

test("cada campo comercial y logístico que guarda updateProductoCatalog marca cambios", () => {
  const edits: Partial<ProductoFormState>[] = [
    { precio: "21000" },
    { precio_anterior: "25000" },
    { categoria_id: "" },
    { descripcion: "<p>Sonido envolvente y graves</p>" },
    { video_url: "https://example.com/video.mp4" },
    { peso_empaquetado_kg: "0,4" },
    { largo_paquete_cm: "21" },
    { ancho_paquete_cm: "19" },
    { alto_paquete_cm: "9" },
    { nombre: "AURICULAR MALIBU PRO" },
    { sku: "AUMN02" },
    { destacado: true },
    { activo: true },
    { pricingMode: "target_margin" },
  ]
  for (const edit of edits) {
    assert.equal(hasProductFormChanges({ ...saved, ...edit }, saved), true, JSON.stringify(edit))
  }
})

test("volver al valor guardado o sólo agregar espacios no deja la ficha sucia", () => {
  assert.equal(hasProductFormChanges({ ...saved, precio: " 20000 " }, saved), false)
  assert.equal(hasProductFormChanges({ ...saved, nombre: `${saved.nombre} ` }, saved), false)
})

test("con margen objetivo el precio derivado en vivo no cuenta como edición", () => {
  const targetSaved = { ...saved, pricingMode: "target_margin" as const, targetMarginPercent: "30" }
  assert.equal(hasProductFormChanges({ ...targetSaved, precio: "23500" }, targetSaved), false)
  assert.equal(hasProductFormChanges({ ...targetSaved, targetMarginPercent: "35" }, targetSaved), true)
})

function variant(id: number, activo: boolean, imagenes: string[] = []): SupabaseProductoVariante {
  return {
    id,
    producto_id: 9,
    nombre: `V${id}`,
    sku: `SKU${id}`,
    color_hex: "#000000",
    stock: 1,
    imagenes,
    activo,
    orden: 1,
    created_at: "2026-10-25T00:00:00.000Z",
  }
}

test("la activación de variantes pendiente de guardar marca cambios; las imágenes ya guardadas no", () => {
  const persisted = [variant(9, false), variant(15, false)]
  assert.equal(hasVariantStateChanges({ 9: false, 15: false }, persisted), false)
  assert.equal(hasVariantStateChanges({ 9: true, 15: false }, persisted), true)
  // Una imagen subida (guardado inmediato) cambia la variante persistida,
  // no su activación.
  const withImages = [variant(9, false, ["https://example.com/negro.webp"]), variant(15, false)]
  assert.equal(hasVariantStateChanges({ 9: false, 15: false }, withImages), false)
  // Una variante nueva aún sin estado pendiente no es una edición.
  assert.equal(hasVariantStateChanges({ 9: false }, persisted), false)
})
