/**
 * `cartSessionId` es la identidad que las RPCs de reserva de stock usan para
 * decidir de quién es una reserva (ver RESERVATION_SESSION_MISMATCH en
 * `supabase/migrations/20260903150000_...`), así que necesita entropía
 * criptográfica real -- adivinarlo permitiría, en teoría, pisar la reserva
 * de otra persona. `crypto.randomUUID()` cubre todos los navegadores
 * modernos en HTTPS (128 bits, ~122 aleatorios). El único fallback aceptable
 * es `crypto.getRandomValues()` (mismo generador, sin el helper de formato
 * UUID) para runtimes que lo tengan pero no `randomUUID`. `Math.random()` NO
 * es criptográficamente seguro (su estado interno es predecible a partir de
 * pocas muestras en varios motores) y sólo se usa como último recurso
 * absoluto, en un contexto sin ninguna Web Crypto API disponible.
 *
 * Se accede vía `globalThis.crypto` tipado como `Partial<Crypto> | undefined`
 * a propósito: `lib.dom` declara `randomUUID`/`getRandomValues` como
 * miembros obligatorios de `Crypto`, así que un `"x" in crypto` normal
 * angosta la rama "ausente" a `never` y rompe el typecheck -- pero en
 * runtime SÍ pueden faltar (motores viejos, contextos no seguros).
 */
export function createCartSessionId() {
  const cryptoRef = globalThis.crypto as Partial<Crypto> | undefined

  if (typeof cryptoRef?.randomUUID === "function") {
    return cryptoRef.randomUUID()
  }

  if (typeof cryptoRef?.getRandomValues === "function") {
    const bytes = cryptoRef.getRandomValues(new Uint8Array(16))
    return `cart-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`
  }

  return `cart-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}
