import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import { getCatalogViewState, isCatalogPartiallyLoaded } from "./catalog-view-state.ts"

test("un fallo de carga sin productos es error, nunca catálogo vacío", () => {
  assert.equal(getCatalogViewState({ loadStatus: "error", totalProducts: 0, visibleProducts: 0 }), "error")
})

test("catálogo cargado sin productos es vacío", () => {
  assert.equal(getCatalogViewState({ loadStatus: "ready", totalProducts: 0, visibleProducts: 0 }), "empty")
})

test("catálogo completo + filtros sin coincidencias: sin coincidencias", () => {
  assert.equal(getCatalogViewState({ loadStatus: "ready", totalProducts: 12, visibleProducts: 0 }), "no-matches")
})

test("catálogo incompleto + filtros sin coincidencias: búsqueda incompleta, no \"sin resultados\"", () => {
  assert.equal(getCatalogViewState({ loadStatus: "error", totalProducts: 24, visibleProducts: 0 }), "incomplete")
})

test("mientras carga el catálogo completo, cero coincidencias todavía es cargando", () => {
  assert.equal(getCatalogViewState({ loadStatus: "loading", totalProducts: 0, visibleProducts: 0 }), "loading")
  assert.equal(getCatalogViewState({ loadStatus: "loading", totalProducts: 24, visibleProducts: 0 }), "loading")
})

test("con productos visibles siempre se muestra la grilla", () => {
  assert.equal(getCatalogViewState({ loadStatus: "loading", totalProducts: 24, visibleProducts: 24 }), "results")
  assert.equal(getCatalogViewState({ loadStatus: "error", totalProducts: 24, visibleProducts: 3 }), "results")
})

test("aviso de carga parcial sólo cuando la carga completa falló y hay productos visibles", () => {
  assert.equal(isCatalogPartiallyLoaded({ loadStatus: "error", visibleProducts: 3 }), true)
  assert.equal(isCatalogPartiallyLoaded({ loadStatus: "error", visibleProducts: 0 }), false)
  // Reintentando (loading) o ya cargado (ready): sin aviso.
  assert.equal(isCatalogPartiallyLoaded({ loadStatus: "loading", visibleProducts: 3 }), false)
  assert.equal(isCatalogPartiallyLoaded({ loadStatus: "ready", visibleProducts: 3 }), false)
})

test("el catálogo conecta Reintentar con una nueva carga y Limpiar filtros con clearAll", () => {
  const layout = readFileSync(new URL("../../components/products/products-page-layout.tsx", import.meta.url), "utf8")
  const status = readFileSync(new URL("../../components/products/catalog-status.tsx", import.meta.url), "utf8")

  assert.match(layout, /setLoadStatus\("error"\)/)
  assert.match(layout, /onRetry=\{retryLoadProducts\}/)
  assert.match(layout, /<CatalogPartialNotice onRetry=\{retryLoadProducts\} \/>/)
  assert.match(layout, /onClearFilters=\{clearAll\}/)
  assert.match(layout, /\[initialCategories, reloadNonce\]/)
  assert.match(status, /No pudimos cargar los productos\./)
  assert.match(status, /No pudimos cargar todos los productos\./)
  assert.match(status, /No pudimos completar la búsqueda\./)
  assert.match(status, /Reintentar/)
  assert.match(status, /Todavía no hay productos disponibles\./)
  assert.match(status, /No encontramos productos con esos filtros\./)
  assert.match(status, /Limpiar filtros/)
})
