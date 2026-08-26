import type { AndreaniBranch, AndreaniBranchWithDistance } from "./types.ts"

export interface GeoPoint {
  lat: number
  lng: number
}

const EARTH_RADIUS_KM = 6371

/**
 * Distancia en línea recta (no ruta real en auto) entre dos puntos, vía la
 * fórmula de Haversine. Es la distancia "aproximada" que se muestra en el
 * selector de sucursales -- suficiente para ordenar por cercanía sin
 * necesitar un proveedor de routing.
 */
export function haversineDistanceKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return EARTH_RADIUS_KM * 2 * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Coordenadas reales de una sucursal Andreani, tal como las devuelve la API
 * (nunca inventadas). Una sucursal sin `coordenadas` en la respuesta real
 * simplemente no participa del ordenamiento por cercanía.
 */
export function parseAndreaniBranchCoordinates(
  branch: AndreaniBranch,
): GeoPoint | null {
  const lat = Number(branch.coordenadas?.latitud)
  const lng = Number(branch.coordenadas?.longitud)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  return { lat, lng }
}

/**
 * Ordena sucursales por cercanía a `origin` (ubicación real del cliente, ya
 * geocodificada -- nunca un valor inventado acá). Sin origen conocido, no
 * hay forma honesta de ordenar por distancia: se devuelven tal cual las
 * trajo Andreani, sin `distanciaKm`, en vez de fingir un orden. Las
 * sucursales sin coordenadas propias quedan al final, no se descartan.
 */
/** "1,2 km" -- formato español, un decimal, siempre marcado como aproximado en la UI. */
export function formatDistanceKm(distanciaKm: number): string {
  return `${distanciaKm.toFixed(1).replace(".", ",")} km`
}

export function sortAndreaniBranchesByDistance<T extends AndreaniBranch>(
  branches: T[],
  origin: GeoPoint | null,
): AndreaniBranchWithDistance[] {
  if (!origin) return branches

  return branches
    .map((branch) => {
      const point = parseAndreaniBranchCoordinates(branch)
      return {
        ...branch,
        distanciaKm: point
          ? Number(haversineDistanceKm(origin, point).toFixed(1))
          : undefined,
      }
    })
    .sort((a, b) => {
      if (a.distanciaKm === undefined) return b.distanciaKm === undefined ? 0 : 1
      if (b.distanciaKm === undefined) return -1
      return a.distanciaKm - b.distanciaKm
    })
}
