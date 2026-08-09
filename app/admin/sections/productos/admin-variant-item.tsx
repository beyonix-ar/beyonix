"use client"

import Image from "next/image"
import { ImageIcon } from "lucide-react"
import type { ReactNode } from "react"

type VariantTone = "normal" | "discounted"
type VariantStateTone = "active" | "inactive" | "warning" | "danger"
type VariantDensity = "compact" | "comfortable"

interface AdminVariantItemProps {
  image: string | null
  imageCount?: number
  name: string
  subtitle?: string
  sku?: string | null
  hideSku?: boolean
  colorHex?: string | null
  colorLabel?: string
  stock: number
  stateLabel: string
  stateTone?: VariantStateTone
  tone?: VariantTone
  selected?: boolean
  density?: VariantDensity
  dropId?: number
  leadingAccessory?: ReactNode
  stateDisabled?: boolean
  onToggleState?: () => void
  actions: ReactNode
}

const stateStyles: Record<VariantStateTone, string> = {
  active: "border-emerald-400/22 bg-emerald-400/9 text-emerald-200",
  inactive: "border-white/10 bg-white/4 text-white/48",
  warning: "border-amber-400/22 bg-amber-400/9 text-amber-200",
  danger: "border-red-400/22 bg-red-400/9 text-red-200",
}

export function AdminVariantThumbnail({
  image,
  name,
  imageCount = 0,
  tone = "normal",
  density = "compact",
}: {
  image: string | null
  name: string
  imageCount?: number
  tone?: VariantTone
  density?: VariantDensity
}) {
  return (
    <span
      className={`relative flex shrink-0 items-center justify-center overflow-hidden border bg-[#07111b] ${
        density === "comfortable" ? "size-16 rounded-2xl" : "size-11 rounded-xl"
      } ${
        tone === "discounted" ? "border-amber-300/24" : "border-white/10"
      }`}
    >
      {image ? (
        <Image
          src={image}
          alt={`Imagen de ${name}`}
          fill
          unoptimized={image.startsWith("blob:") || image.startsWith("data:")}
          sizes={density === "comfortable" ? "64px" : "44px"}
          className="object-cover"
        />
      ) : (
        <ImageIcon className="size-4 text-white/22" aria-hidden="true" />
      )}
      {imageCount > 1 && (
        <span className="absolute bottom-0.5 right-0.5 rounded-md border border-white/12 bg-black/80 px-1 text-8px font-black text-white/65">
          +{imageCount - 1}
        </span>
      )}
    </span>
  )
}

export function AdminVariantItem({
  image,
  imageCount = 0,
  name,
  subtitle,
  sku,
  hideSku = false,
  colorHex,
  colorLabel,
  stock,
  stateLabel,
  stateTone = "active",
  tone = "normal",
  selected = false,
  density = "compact",
  dropId,
  leadingAccessory,
  stateDisabled = false,
  onToggleState,
  actions,
}: AdminVariantItemProps) {
  const stateControl = onToggleState ? (
    <button
      type="button"
      disabled={stateDisabled}
      title={`Cambiar estado: actualmente ${stateLabel.toLocaleLowerCase("es")}`}
      aria-label={`Cambiar estado de ${name}`}
      onClick={onToggleState}
      className={`inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-bold transition hover:border-cyan-300/35 ${stateStyles[stateTone]} disabled:cursor-wait disabled:opacity-60`}
    >
      <span className="size-1.5 rounded-full bg-current opacity-80" />
      {stateLabel}
    </button>
  ) : (
    <span
      title={stateLabel}
      aria-label={`Estado de ${name}: ${stateLabel}`}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-bold ${stateStyles[stateTone]}`}
    >
      <span className="size-1.5 rounded-full bg-current opacity-80" />
      {stateLabel}
    </span>
  )

  if (density === "comfortable") {
    return (
      <article
        data-variant-drop-id={dropId}
        className={`admin-variant-item rounded-2xl border p-4 transition-colors sm:p-5 ${
          tone === "discounted"
            ? "border-amber-300/22 bg-amber-300/[0.045]"
            : "border-beyonix-blue-light/18 bg-white/[0.025]"
        } ${selected ? "ring-1 ring-cyan-300/55 shadow-[0_0_20px_rgba(34,211,238,0.08)]" : ""}`}
      >
        <div className="flex min-w-0 items-start gap-3.5">
          {leadingAccessory}
          <AdminVariantThumbnail
            image={image}
            imageCount={imageCount}
            name={name}
            tone={tone}
            density="comfortable"
          />
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="truncate text-base font-black text-white" title={name}>
              {name}
            </p>
            <p className="mt-1 truncate text-sm text-white/48">
              {subtitle ||
                (imageCount
                  ? `${imageCount} ${imageCount === 1 ? "imagen" : "imágenes"}`
                  : "Sin imagen")}
            </p>
          </div>
          <div className="hidden shrink-0 sm:block">{stateControl}</div>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-white/8 pt-4 sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="text-xs font-bold text-white/46">SKU</dt>
            <dd className="mt-1 truncate text-sm font-black text-white/82" title={hideSku ? undefined : sku?.trim() || "Sin SKU"}>
              {hideSku ? null : sku?.trim() || "Sin SKU"}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs font-bold text-white/46">Color</dt>
            <dd className="mt-1 flex min-w-0 items-center gap-2 text-sm font-black text-white/82">
              {colorHex ? (
                <span className="size-4 shrink-0 rounded-full border border-white/25" style={{ backgroundColor: colorHex }} />
              ) : null}
              <span className="truncate">{colorLabel || colorHex || "Sin color"}</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs font-bold text-white/46">Stock</dt>
            <dd className="mt-1 text-lg font-black tabular-nums text-white">{stock}</dd>
          </div>
        </dl>

        <div className="mt-4 flex flex-col gap-3 border-t border-white/8 pt-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="sm:hidden">{stateControl}</div>
          <div className="admin-product-actions flex flex-wrap items-center justify-end gap-2 sm:ml-auto">
            {actions}
          </div>
        </div>
      </article>
    )
  }

  return (
    <article
      data-variant-drop-id={dropId}
      className={`admin-variant-item admin-variant-compact grid grid-cols-admin-product-summary items-center gap-3 rounded-xl border px-4 py-2.5 transition-colors ${
        tone === "discounted"
          ? "border-amber-300/22 bg-amber-300/[0.045]"
          : "border-cyan-400/13 bg-cyan-400/[0.035]"
      } ${selected ? "ring-1 ring-cyan-300/55 shadow-[0_0_20px_rgba(34,211,238,0.08)]" : ""}`}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {leadingAccessory}
        <AdminVariantThumbnail
          image={image}
          imageCount={imageCount}
          name={name}
          tone={tone}
          density={density}
        />
        <div className="min-w-0">
          <p className="truncate text-xs font-black text-white" title={name}>
            {name}
          </p>
          <p className="mt-0.5 truncate text-9px text-white/40">
            {subtitle ||
              (imageCount
                ? `${imageCount} ${imageCount === 1 ? "imagen" : "imágenes"}`
                : "Sin imagen")}
          </p>
        </div>
      </div>

      <div data-label="SKU" className="min-w-0 justify-self-stretch text-center">
        <p className="truncate text-xs font-bold text-white/68" title={hideSku ? undefined : sku?.trim() || "Sin SKU"}>
          {hideSku ? null : sku?.trim() || "Sin SKU"}
        </p>
      </div>

      <div data-label="Cantidad" className="justify-self-center text-center">
        <p className="text-sm font-black tabular-nums text-white">{stock}</p>
      </div>

      <div data-label="Color" className="flex min-w-0 items-center justify-center gap-1.5">
        {colorHex ? (
          <span
            className="size-3.5 shrink-0 rounded-full border border-white/25"
            style={{ backgroundColor: colorHex }}
          />
        ) : null}
        <span className="truncate text-xs font-bold text-white/62" title={colorLabel || colorHex || "Sin color"}>
          {colorLabel || colorHex || "Sin color"}
        </span>
      </div>

      <div data-label="Precio" aria-hidden="true" />

      <div data-label="Estado" className="justify-self-center">
        {stateControl}
      </div>

      <div className="admin-product-actions flex items-center justify-center gap-1.5">
        {actions}
      </div>
    </article>
  )
}
