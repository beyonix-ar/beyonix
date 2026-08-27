"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { MapContainer, Marker, TileLayer, useMap } from "react-leaflet"
import L from "leaflet"
import "leaflet/dist/leaflet.css"
import { Check, Search } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  formatAndreaniBranchAddress,
  formatAndreaniBranchStreetLine,
} from "@/lib/andreani/branch-address"
import { formatDistanceKm } from "@/lib/andreani/branch-distance"
import type { AndreaniBranchWithDistance } from "@/lib/andreani/types"

/**
 * Proveedor de tiles: OpenStreetMap estándar por defecto (sin API key, sin
 * billing). El volumen esperado acá (unos pocos tiles por checkout que usa
 * sucursal) está lejos de la política de uso razonable de OSM
 * (https://operations.osmfoundation.org/policies/tiles/), pero se deja
 * configurable vía env var para poder pasar a un proveedor dedicado si el
 * tráfico de producción lo justifica más adelante.
 */
const TILE_URL =
  process.env.NEXT_PUBLIC_OSM_TILE_URL?.trim() ||
  "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors'

function normalizeSearchText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
}

function branchMatchesSearch(branch: AndreaniBranchWithDistance, query: string) {
  if (!query) return true
  const haystack = normalizeSearchText(
    `${branch.descripcion} ${formatAndreaniBranchAddress(branch.direccion)} ${branch.direccion.localidad}`,
  )
  return haystack.includes(query)
}

function branchDivIcon(selected: boolean) {
  return L.divIcon({
    className: "",
    html: `<div class="${
      selected
        ? "flex size-8 items-center justify-center rounded-full border-2 border-white bg-beyonix-sky text-beyonix-blue shadow-lg"
        : "flex size-7 items-center justify-center rounded-full border-2 border-white bg-beyonix-blue-light/90 text-white shadow"
    }" style="font-size:${selected ? "16px" : "12px"};font-weight:700;">${selected ? "&#10003;" : "&#8226;"}</div>`,
    iconSize: selected ? [32, 32] : [28, 28],
    iconAnchor: selected ? [16, 16] : [14, 14],
  })
}

/** Encuadra el mapa para que todos los marcadores entren, una sola vez por cada lista de sucursales (no en cada render). */
function FitBoundsToBranches({ branches }: { branches: AndreaniBranchWithDistance[] }) {
  const map = useMap()
  const boundsKey = branches.map((branch) => branch.id).join(",")

  useEffect(() => {
    const points = branches
      .map((branch) => {
        const lat = Number(branch.coordenadas?.latitud)
        const lng = Number(branch.coordenadas?.longitud)
        return Number.isFinite(lat) && Number.isFinite(lng)
          ? ([lat, lng] as [number, number])
          : null
      })
      .filter((point): point is [number, number] => point !== null)

    if (points.length === 0) return
    if (points.length === 1) {
      map.setView(points[0], 15)
      return
    }
    map.fitBounds(L.latLngBounds(points), { padding: [32, 32] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundsKey])

  return null
}

/** Centra/enfoca el marcador seleccionado cuando cambia la selección (desde la lista o desde el propio mapa). */
function FlyToSelected({
  branches,
  selectedId,
}: {
  branches: AndreaniBranchWithDistance[]
  selectedId: number | null
}) {
  const map = useMap()

  useEffect(() => {
    if (selectedId === null) return
    const branch = branches.find((item) => item.id === selectedId)
    const lat = Number(branch?.coordenadas?.latitud)
    const lng = Number(branch?.coordenadas?.longitud)
    if (!branch || !Number.isFinite(lat) || !Number.isFinite(lng)) return
    map.flyTo([lat, lng], Math.max(map.getZoom(), 15), { duration: 0.6 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  return null
}

export interface BranchMapPickerProps {
  branches: AndreaniBranchWithDistance[]
  selectedId: number | null
  onSelect: (branchId: number) => void
  hasSelectionError?: boolean
}

export function BranchMapPicker({
  branches,
  selectedId,
  onSelect,
  hasSelectionError,
}: BranchMapPickerProps) {
  const [search, setSearch] = useState("")
  const cardRefs = useRef(new Map<number, HTMLButtonElement>())

  const query = normalizeSearchText(search)
  const filteredBranches = useMemo(
    () => branches.filter((branch) => branchMatchesSearch(branch, query)),
    [branches, query],
  )

  useEffect(() => {
    if (selectedId === null) return
    cardRefs.current.get(selectedId)?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [selectedId])

  const nearestId =
    branches.length > 0 && branches[0].distanciaKm !== undefined ? branches[0].id : null
  const mapPoints = useMemo(
    () =>
      branches.filter((branch) => {
        const lat = Number(branch.coordenadas?.latitud)
        const lng = Number(branch.coordenadas?.longitud)
        return Number.isFinite(lat) && Number.isFinite(lng)
      }),
    [branches],
  )
  const initialCenter: [number, number] =
    mapPoints.length > 0
      ? [Number(mapPoints[0].coordenadas!.latitud), Number(mapPoints[0].coordenadas!.longitud)]
      : [-34.6037, -58.3816]

  if (branches.length === 0) return null

  return (
    <div className="flex flex-col gap-3 lg:flex-row">
      <div
        className={cn(
          "flex flex-col gap-2 rounded-2xl border p-3 lg:w-[38%]",
          hasSelectionError && !selectedId
            ? "border-red-400/40 shadow-[0_0_0_2px_rgba(248,113,113,0.12)]"
            : "border-beyonix-blue-light/16",
        )}
      >
        {branches.length > 5 && (
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-white/40" />
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Buscar sucursal o dirección"
              className="w-full rounded-lg border border-white/10 bg-black/25 py-2 pl-8 pr-3 text-xs text-white placeholder:text-white/35 focus:border-beyonix-sky/50 focus:outline-none"
            />
          </div>
        )}
        <div className="grid max-h-[420px] gap-2 overflow-y-auto pr-1">
          {filteredBranches.length === 0 ? (
            <p className="p-2 text-xs text-white/55">
              Ninguna sucursal coincide con tu búsqueda.
            </p>
          ) : (
            filteredBranches.map((branch) => {
              const selected = selectedId === branch.id

              return (
                <button
                  key={branch.id}
                  type="button"
                  ref={(node) => {
                    if (node) cardRefs.current.set(branch.id, node)
                    else cardRefs.current.delete(branch.id)
                  }}
                  onClick={() => onSelect(branch.id)}
                  className={cn(
                    "flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2.5 text-left transition-colors",
                    selected
                      ? "border-beyonix-sky/50 bg-beyonix-blue/30"
                      : "border-white/8 bg-black/20 hover:border-white/20",
                  )}
                >
                  <span className="flex w-full items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-white">
                      {branch.descripcion}
                    </span>
                    {selected && (
                      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-beyonix-blue-light/35 bg-beyonix-blue/50 text-beyonix-sky">
                        <Check className="size-3" />
                      </span>
                    )}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-1.5 text-xs">
                    {branch.distanciaKm !== undefined && (
                      <span
                        className={cn(
                          "font-semibold",
                          branch.id === nearestId ? "text-beyonix-sky" : "text-white/70",
                        )}
                      >
                        {branch.id === nearestId ? "Más cercana · " : ""}
                        {formatDistanceKm(branch.distanciaKm)}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-white/60">
                    {formatAndreaniBranchStreetLine(branch.direccion) ||
                      formatAndreaniBranchAddress(branch.direccion)}
                  </span>
                  <span className="text-xs text-white/45">
                    {branch.direccion.localidad}, {branch.direccion.provincia} · CP{" "}
                    {branch.direccion.codigoPostal}
                  </span>
                  {branch.horarioDeAtencion && (
                    <span className="text-[11px] text-white/40">{branch.horarioDeAtencion}</span>
                  )}
                </button>
              )
            })
          )}
        </div>
      </div>

      <div className="h-64 overflow-hidden rounded-2xl border border-beyonix-blue-light/16 lg:h-auto lg:min-h-[420px] lg:flex-1">
        <MapContainer
          center={initialCenter}
          zoom={13}
          scrollWheelZoom
          style={{ height: "100%", width: "100%" }}
        >
          <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />
          <FitBoundsToBranches branches={mapPoints} />
          <FlyToSelected branches={mapPoints} selectedId={selectedId} />
          {mapPoints.map((branch) => (
            <Marker
              key={branch.id}
              position={[
                Number(branch.coordenadas!.latitud),
                Number(branch.coordenadas!.longitud),
              ]}
              icon={branchDivIcon(selectedId === branch.id)}
              eventHandlers={{ click: () => onSelect(branch.id) }}
            />
          ))}
        </MapContainer>
      </div>
    </div>
  )
}
