"use client"

import { AlertTriangle, LoaderCircle, PackageSearch, RefreshCw, SearchX } from "lucide-react"

import { BeyonixButton, BeyonixEmptyState } from "@/components/beyonix-ui"
import type { CatalogViewState } from "@/lib/products/catalog-view-state"

interface CatalogStatusProps {
  state: Exclude<CatalogViewState, "results">
  onRetry: () => void
  onClearFilters: () => void
}

export function CatalogStatus({ state, onRetry, onClearFilters }: CatalogStatusProps) {
  if (state === "loading") {
    return (
      <div role="status" className="flex min-h-220px items-center justify-center gap-2 text-beyonix-sky/70">
        <LoaderCircle className="size-5 animate-spin" aria-hidden="true" />
        Cargando productos...
      </div>
    )
  }

  if (state === "error") {
    return (
      <BeyonixEmptyState
        icon={<RefreshCw className="size-5" />}
        title="No pudimos cargar los productos."
        description="Revisá tu conexión e intentá de nuevo."
        action={
          <BeyonixButton type="button" variant="outline" onClick={onRetry}>
            Reintentar
          </BeyonixButton>
        }
      />
    )
  }

  if (state === "incomplete") {
    return (
      <BeyonixEmptyState
        icon={<RefreshCw className="size-5" />}
        title="No pudimos completar la búsqueda."
        description="Puede haber productos que todavía no cargaron."
        action={
          <BeyonixButton type="button" variant="outline" onClick={onRetry}>
            Reintentar
          </BeyonixButton>
        }
      />
    )
  }

  if (state === "no-matches") {
    return (
      <BeyonixEmptyState
        icon={<SearchX className="size-5" />}
        title="No encontramos productos con esos filtros."
        action={
          <BeyonixButton type="button" variant="outline" onClick={onClearFilters}>
            Limpiar filtros
          </BeyonixButton>
        }
      />
    )
  }

  return (
    <BeyonixEmptyState
      icon={<PackageSearch className="size-5" />}
      title="Todavía no hay productos disponibles."
    />
  )
}

/** Aviso compacto sobre la grilla cuando sólo se ve una parte del catálogo. */
export function CatalogPartialNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="status"
      className="beyonix-catalog-partial-notice mb-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-xl border border-[var(--account-warning-border)] bg-[var(--account-warning-bg)] px-4 py-2.5 text-sm"
    >
      <span className="flex min-w-0 items-center gap-2 text-[var(--account-text-primary)]">
        <AlertTriangle className="size-4 shrink-0 text-[var(--account-warning)]" aria-hidden="true" />
        No pudimos cargar todos los productos.
      </span>
      <BeyonixButton type="button" variant="outline" size="sm" onClick={onRetry}>
        Reintentar
      </BeyonixButton>
    </div>
  )
}
