/**
 * Bloquea el scroll del documento mientras un modal está abierto y, al
 * liberarlo, deja la página exactamente en la posición en la que estaba.
 * Compensa el ancho de la barra de scroll para que el fondo no se desplace
 * horizontalmente. Admite bloqueos anidados (sólo el último restaura).
 */
let depth = 0
let saved: { htmlOverflow: string; bodyOverflow: string; bodyPaddingRight: string; x: number; y: number } | null = null

export function lockDocumentScroll() {
  const html = document.documentElement
  const body = document.body
  if (depth === 0) {
    const scrollbar = window.innerWidth - html.clientWidth
    saved = {
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
      bodyPaddingRight: body.style.paddingRight,
      x: window.scrollX,
      y: window.scrollY,
    }
    html.style.overflow = "hidden"
    body.style.overflow = "hidden"
    if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`
  }
  depth++
  let released = false
  return () => {
    if (released) return
    released = true
    depth--
    if (depth > 0 || !saved) return
    const { htmlOverflow, bodyOverflow, bodyPaddingRight, x, y } = saved
    saved = null
    html.style.overflow = htmlOverflow
    body.style.overflow = bodyOverflow
    body.style.paddingRight = bodyPaddingRight
    if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y)
  }
}
