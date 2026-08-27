import "server-only"

/**
 * `GET /v3/envios/{id}/trazas` (tracking) devuelve `Fecha` SIN offset de
 * timezone -- ej. "2026-08-26T15:11:02.4760000" -- a diferencia de
 * `GET /v2/ordenes-de-envio/{id}` (`fechaCreacion`), que sí trae offset
 * explícito ("2026-08-26T15:10:51-03:00"). Confirmado en vivo comparando
 * ambos endpoints contra el mismo envío real (PROD, 2026-08-26T18:10 UTC):
 * el timestamp naive de trazas es la misma hora de pared que `fechaCreacion`
 * para prácticamente el mismo instante -- es decir, hora de Argentina (ART,
 * UTC-3, sin horario de verano), nunca UTC. Sin este parseo, Postgres
 * interpreta el string naive con el timezone de sesión (UTC), corriendo el
 * timestamp persistido ~3 horas respecto al real: es la causa exacta del
 * desfase detectado entre `andreani_tracking_event_at` y
 * `andreani_tracking_checked_at`.
 *
 * Parsing timezone-safe (no asume ciegamente Argentina): si el string YA
 * trae offset explícito o sufijo "Z" -- ya sea porque Andreani lo agrega en
 * el futuro, o en cualquier otro campo de fecha con offset como
 * `fechaCreacion`/`fechaEstimadaDeEntrega` -- se respeta tal cual y nunca se
 * le suma nada. El offset fijo sólo se completa cuando el string es
 * comprobadamente naive.
 */
const ANDREANI_NAIVE_TRACKING_TIMESTAMP_OFFSET = "-03:00"
const HAS_EXPLICIT_TIMEZONE_PATTERN = /(?:Z|[+-]\d{2}:?\d{2})$/

export function isNaiveAndreaniTimestamp(value: string): boolean {
  return !HAS_EXPLICIT_TIMEZONE_PATTERN.test(value.trim())
}

/**
 * Convierte un timestamp devuelto por Andreani (naive u ofsetado) a un ISO
 * 8601 UTC válido para persistir en una columna `timestamptz`. Lanza si el
 * resultado no es una fecha válida -- nunca persiste "Invalid Date".
 */
export function parseAndreaniTimestamp(value: string): string {
  const trimmed = value.trim()
  const isoCandidate = isNaiveAndreaniTimestamp(trimmed)
    ? `${trimmed}${ANDREANI_NAIVE_TRACKING_TIMESTAMP_OFFSET}`
    : trimmed

  const parsed = new Date(isoCandidate)
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError(`Andreani devolvió una fecha inválida: "${value}".`)
  }

  return parsed.toISOString()
}
