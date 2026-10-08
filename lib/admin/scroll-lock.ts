/**
 * Bloquea el scroll del documento mientras un modal/menú está abierto y, al
 * liberarlo, deja la página exactamente en la posición en la que estaba.
 *
 * Con `preventTouchScroll` (menús y paneles de la tienda), además de
 * `overflow: hidden` fija el <body> desplazado (`position: fixed` con
 * `top: -scrollY`): es lo único que frena el scroll táctil del fondo en
 * Safari iOS y en algunos Android, donde `overflow` solo no alcanza. Sólo
 * el contenido con scroll propio (el panel abierto) se mueve. Mientras está
 * fijado, window.scrollY vale 0; por eso Admin (que no lo necesita) sigue con
 * el bloqueo sólo por overflow.
 * Compensa el ancho de la barra de scroll para que el fondo no se desplace
 * horizontalmente. Admite bloqueos anidados (sólo el último restaura).
 */
let depth = 0
let saved: {
  htmlOverflow: string
  bodyOverflow: string
  bodyPaddingRight: string
  bodyPosition: string
  bodyTop: string
  bodyLeft: string
  bodyRight: string
  bodyWidth: string
  x: number
  y: number
} | null = null

export function lockDocumentScroll({ preventTouchScroll = false }: { preventTouchScroll?: boolean } = {}) {
  const html = document.documentElement
  const body = document.body
  if (depth === 0) {
    const scrollbar = window.innerWidth - html.clientWidth
    const x = window.scrollX
    const y = window.scrollY
    saved = {
      htmlOverflow: html.style.overflow,
      bodyOverflow: body.style.overflow,
      bodyPaddingRight: body.style.paddingRight,
      bodyPosition: body.style.position,
      bodyTop: body.style.top,
      bodyLeft: body.style.left,
      bodyRight: body.style.right,
      bodyWidth: body.style.width,
      x,
      y,
    }
    html.style.overflow = "hidden"
    body.style.overflow = "hidden"
    if (preventTouchScroll) {
      body.style.position = "fixed"
      body.style.top = `${-y}px`
      body.style.left = `${-x}px`
      body.style.right = "0"
      body.style.width = "100%"
    }
    if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`
    // Los elementos fixed (header) compensan el mismo ancho vía esta variable.
    html.style.setProperty("--beyonix-scroll-lock-gap", `${Math.max(scrollbar, 0)}px`)
  }
  depth++
  let released = false
  return () => {
    if (released) return
    released = true
    depth--
    if (depth > 0 || !saved) return
    const restore = saved
    saved = null
    html.style.overflow = restore.htmlOverflow
    body.style.overflow = restore.bodyOverflow
    body.style.paddingRight = restore.bodyPaddingRight
    body.style.position = restore.bodyPosition
    body.style.top = restore.bodyTop
    body.style.left = restore.bodyLeft
    body.style.right = restore.bodyRight
    body.style.width = restore.bodyWidth
    html.style.removeProperty("--beyonix-scroll-lock-gap")
    // "instant": aunque la página tuviera scroll suave, se vuelve al mismo
    // punto sin animación ni salto visible.
    if (window.scrollX !== restore.x || window.scrollY !== restore.y) {
      window.scrollTo({ left: restore.x, top: restore.y, behavior: "instant" })
    }
  }
}
