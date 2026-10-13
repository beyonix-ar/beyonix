// Descripción enriquecida de producto. Allowlist estricta: bloques, listas,
// strong/em/u y spans con tamaño discreto. Todo lo demás se
// descarta (script, iframe, style, atributos on*, javascript:, estilos...).
// El texto plano legacy (sin etiquetas) sigue funcionando: párrafos por línea
// en blanco y saltos simples como <br>.
//
// La salida del parser es un árbol de datos: la tienda lo renderiza como
// elementos React (sin innerHTML), así que incluso un valor persistido sin
// sanitizar no puede inyectar marcado.

export const RICH_TEXT_SIZES = [12, 14, 16, 18, 20, 22, 24, 28, 32, 36, 40] as const
export type RichTextSize = (typeof RICH_TEXT_SIZES)[number]
export type RichAlignment = "left" | "center" | "right"
export const RICH_TEXT_FONTS = ["arial", "calibri", "verdana", "comic-sans"] as const
export type RichTextFont = (typeof RICH_TEXT_FONTS)[number]
export const RICH_TEXT_COLORS = [
  { id: "black", label: "Negro", hex: "#000000" },
  { id: "white", label: "Blanco", hex: "#ffffff" },
  { id: "gray", label: "Gris", hex: "#64748b" },
  { id: "beyonix-blue", label: "Azul BEYONIX", hex: "#1e4d7b" },
  { id: "sky", label: "Celeste", hex: "#8cc8f2" },
  { id: "green", label: "Verde", hex: "#34d399" },
  { id: "red", label: "Rojo", hex: "#ef4444" },
  { id: "amber", label: "Ámbar", hex: "#f59e0b" },
] as const
export type RichTextColor = (typeof RICH_TEXT_COLORS)[number]["id"]

export type RichInline =
  | { type: "text"; text: string }
  | { type: "br" }
  | { type: "strong" | "em" | "u"; children: RichInline[] }
  | { type: "weight-normal"; children: RichInline[] }
  | { type: "size"; size: RichTextSize; children: RichInline[] }
  | { type: "font"; font: RichTextFont; children: RichInline[] }
  | { type: "color"; color: RichTextColor; children: RichInline[] }

export type RichBlockType = "p" | "h2" | "h3"
export type RichBlock =
  | { type: RichBlockType; children: RichInline[]; align?: RichAlignment }
  | { type: "ul"; items: RichInline[][]; align?: RichAlignment }
  | { type: "ol"; items: RichInline[][]; align?: RichAlignment }

/** Tope defensivo: una descripción real nunca se acerca a esto. */
export const RICH_DESCRIPTION_MAX_LENGTH = 50_000

type HtmlNode =
  | { kind: "text"; text: string }
  | { kind: "element"; name: string; attrs: Record<string, string>; children: HtmlNode[] }

// Su contenido nunca es texto visible: se descarta entero.
const DROPPED_WITH_CONTENT = new Set([
  "script", "style", "iframe", "object", "embed", "template", "noscript",
  "textarea", "select", "option", "svg", "math", "head", "title", "frame",
  "frameset", "noframes", "xmp", "plaintext", "canvas", "video", "audio",
  "picture", "form", "button", "input", "img",
])
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "noscript", "iframe", "noframes", "plaintext"])
const VOID_ELEMENTS = new Set(["br", "hr", "img", "input", "meta", "link", "wbr", "area", "base", "col", "embed", "source", "track", "param"])
const BLOCK_ELEMENTS = new Set([
  "html", "body", "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "blockquote",
  "section", "article", "header", "footer", "aside", "main", "nav", "pre", "table",
  "tr", "td", "th", "tbody", "thead", "dl", "dt", "dd", "figure", "figcaption", "hr",
])
const HTML_HINT = /<\/?(?:p|br|strong|b|em|i|u|h[1-6]|span|div|font|ul|ol|li)\b[^>]*>/i

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
  ntilde: "ñ", Ntilde: "Ñ", uuml: "ü", Uuml: "Ü", iexcl: "¡", iquest: "¿",
  laquo: "«", raquo: "»", deg: "°", ordm: "º", ordf: "ª", middot: "·",
  hellip: "…", mdash: "—", ndash: "–", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
}

function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
        ? String.fromCodePoint(code)
        : ""
    }
    return NAMED_ENTITIES[entity] ?? match
  })
}

function parseAttributes(source: string) {
  const attrs: Record<string, string> = {}
  const pattern = /([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  for (const match of source.matchAll(pattern)) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "")
  }
  return attrs
}

/** Árbol HTML tolerante (sin DOM): igual en servidor, navegador y tests. */
function parseHtml(input: string): HtmlNode[] {
  const root: HtmlNode = { kind: "element", name: "#root", attrs: {}, children: [] }
  const stack: Extract<HtmlNode, { kind: "element" }>[] = [root]
  const token = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g
  let match: RegExpExecArray | null
  while ((match = token.exec(input))) {
    const [raw, closing, rawName, rawAttrs] = match
    const current = stack[stack.length - 1]
    if (rawName === undefined) {
      if (raw.startsWith("<!") || raw.startsWith("<?")) continue
      current.children.push({ kind: "text", text: decodeEntities(raw) })
      continue
    }
    const name = rawName.toLowerCase()
    if (closing) {
      const index = stack.map((node) => node.name).lastIndexOf(name)
      if (index > 0) stack.length = index
      continue
    }
    if (RAW_TEXT.has(name)) {
      // Se saltea hasta su cierre: su contenido nunca se interpreta.
      const close = new RegExp(`</${name}\\b[^>]*>`, "gi")
      close.lastIndex = token.lastIndex
      const end = close.exec(input)
      token.lastIndex = end ? close.lastIndex : input.length
      continue
    }
    const element: HtmlNode = { kind: "element", name, attrs: parseAttributes(rawAttrs ?? ""), children: [] }
    current.children.push(element)
    if (!VOID_ELEMENTS.has(name) && !/\/\s*$/.test(rawAttrs ?? "")) stack.push(element)
  }
  return root.children
}

function sizeFromAttributes(name: string, attrs: Record<string, string>): RichTextSize | null {
  const classSize = /(?:^|\s)rt-size-(12|14|16|18|20|22|24|28|32|36|40)(?:\s|$)/.exec(attrs.class ?? "")?.[1]
  if (classSize) return Number(classSize) as RichTextSize
  // El navegador puede reescribir un tamaño discreto como píxeles inline.
  const pixels = /(?:^|;)\s*font-size\s*:\s*(\d+)px\s*(?:;|$)/i.exec(attrs.style ?? "")?.[1]
  if (pixels && RICH_TEXT_SIZES.includes(Number(pixels) as RichTextSize)) return Number(pixels) as RichTextSize
  const legacy = /(?:^|\s)rt-size-(sm|lg|xl)(?:\s|$)/.exec(attrs.class ?? "")?.[1]
  if (legacy) return { sm: 14, lg: 18, xl: 20 }[legacy as "sm" | "lg" | "xl"] as RichTextSize
  if (name === "font") {
    const face = /^rt-size-(12|14|16|18|20|22|24|28|32|36|40)$/.exec(attrs.face ?? "")?.[1]
    if (face) return Number(face) as RichTextSize
  }
  if (name === "font" && attrs.size) {
    const size = Number(attrs.size)
    if (size <= 2) return 14
    if (size === 4) return 18
    if (size >= 5) return 20
    return null
  }
  const cssSize = /font-size\s*:\s*([a-z-]+)/i.exec(attrs.style ?? "")?.[1]?.toLowerCase()
  if (cssSize === "x-small" || cssSize === "small") return 14
  if (cssSize === "large") return 18
  if (cssSize === "x-large" || cssSize === "xx-large" || cssSize === "xxx-large") return 20
  return null
}

function fontFromAttributes(name: string, attrs: Record<string, string>): RichTextFont | null {
  const canonical = /(?:^|\s)rt-font-(arial|calibri|verdana|comic-sans)(?:\s|$)/.exec(attrs.class ?? "")?.[1]
  if (canonical) return canonical as RichTextFont
  const raw = (name === "font" ? attrs.face : undefined)
    ?? /(?:^|;)\s*font-family\s*:\s*([^;]+)/i.exec(attrs.style ?? "")?.[1]
  const family = raw?.split(",")[0]?.trim().replace(/^["']|["']$/g, "").toLowerCase()
  return family === "arial" || family === "calibri" || family === "verdana"
    ? family : family === "comic sans ms" ? "comic-sans" : null
}

function colorFromAttributes(name: string, attrs: Record<string, string>): RichTextColor | null {
  const canonical = /(?:^|\s)rt-color-(black|white|gray|beyonix-blue|sky|green|red|amber)(?:\s|$)/.exec(attrs.class ?? "")?.[1]
  if (canonical) return canonical as RichTextColor
  const raw = ((name === "font" ? attrs.color : undefined)
    ?? /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(attrs.style ?? "")?.[1])?.trim().toLowerCase()
  if (!raw) return null
  const normalized = raw.replace(/\s+/g, "")
  const match = RICH_TEXT_COLORS.find(({ hex }) => {
    const rgb = hex.match(/[a-f0-9]{2}/g)?.map((part) => Number.parseInt(part, 16)).join(",")
    return normalized === hex || normalized === `rgb(${rgb})`
  })
  return match?.id ?? null
}

function alignmentFromAttributes(attrs: Record<string, string>): RichAlignment | undefined {
  const canonical = /(?:^|\s)rt-align-(left|center|right)(?:\s|$)/.exec(attrs.class ?? "")?.[1]
  if (canonical) return canonical as RichAlignment
  const align = attrs.align?.toLowerCase()
  if (align === "left" || align === "center" || align === "right") return align
  const style = /(?:^|;)\s*text-align\s*:\s*(left|center|right)\s*(?:;|$)/i.exec(attrs.style ?? "")?.[1]
  return style?.toLowerCase() as RichAlignment | undefined
}

/**
 * Formato efectivo de un tramo de texto. El editor y el sanitizer lo resuelven
 * igual: el elemento más interno gana, así que nunca quedan estilos del mismo
 * tipo anidados y contradictorios.
 */
export type RichMarks = {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  size?: RichTextSize
  font?: RichTextFont
  color?: RichTextColor
}
export type RichRun =
  | { type: "text"; text: string; marks: RichMarks }
  | { type: "br"; marks: RichMarks }

const ZERO_WIDTH_SPACE = /​/g

function styleDeclarations(style: string | undefined) {
  const declarations = new Map<string, string>()
  for (const declaration of (style ?? "").split(";")) {
    const separator = declaration.indexOf(":")
    if (separator > 0) {
      declarations.set(declaration.slice(0, separator).trim().toLowerCase(), declaration.slice(separator + 1).trim().toLowerCase())
    }
  }
  return declarations
}

/**
 * Formato que aporta un elemento. Word y Google Docs marcan negrita, cursiva y
 * subrayado con estilos inline: se traducen a marcas permitidas y el resto del
 * estilo se descarta. Google Docs envuelve lo copiado en <b style="font-weight:normal">.
 */
export function richMarksFromElement(name: string, attrs: Record<string, string>): RichMarks {
  const marks: RichMarks = {}
  const declarations = styleDeclarations(attrs.style)
  const weight = declarations.get("font-weight")
  const styleNormal = /^(normal|[1-5]00)\b/.test(weight ?? "")
  if (styleNormal || /(?:^|\s)rt-weight-normal(?:\s|$)/.test(attrs.class ?? "")) marks.bold = false
  if ((weight && (/^bold(er)?$/.test(weight) || Number(weight) >= 600)) || ((name === "strong" || name === "b") && !styleNormal)) {
    marks.bold = true
  }
  const fontStyle = declarations.get("font-style") ?? ""
  if (name === "em" || name === "i" || /^(italic|oblique)\b/.test(fontStyle)) marks.italic = true
  else if (fontStyle === "normal") marks.italic = false
  const decoration = `${declarations.get("text-decoration") ?? ""} ${declarations.get("text-decoration-line") ?? ""}`
  if (name === "u" || /\bunderline\b/.test(decoration)) marks.underline = true
  else if (/\bnone\b/.test(decoration)) marks.underline = false
  if (name === "span" || name === "font") {
    const size = sizeFromAttributes(name, attrs)
    const font = fontFromAttributes(name, attrs)
    const color = colorFromAttributes(name, attrs)
    if (size) marks.size = size
    if (font) marks.font = font
    if (color) marks.color = color
  }
  return marks
}

function hasVisibleRuns(runs: RichRun[]) {
  return runs.some((run) => run.type === "text" && run.text.trim() !== "")
}

type Wrapper = { key: string; wrap: (children: RichInline[]) => RichInline }
// Orden fijo de afuera hacia adentro: el HTML resultante es predecible.
const LAYERS: ((marks: RichMarks, boldContext: boolean) => Wrapper | null)[] = [
  ({ color }) => color ? { key: color, wrap: (children) => ({ type: "color", color, children }) } : null,
  ({ font }) => font ? { key: font, wrap: (children) => ({ type: "font", font, children }) } : null,
  ({ size }) => size ? { key: String(size), wrap: (children) => ({ type: "size", size, children }) } : null,
  ({ bold }, boldContext) => bold === false && boldContext ? { key: "normal", wrap: (children) => ({ type: "weight-normal", children }) } : null,
  ({ bold }) => bold ? { key: "strong", wrap: (children) => ({ type: "strong", children }) } : null,
  ({ italic }) => italic ? { key: "em", wrap: (children) => ({ type: "em", children }) } : null,
  ({ underline }) => underline ? { key: "u", wrap: (children) => ({ type: "u", children }) } : null,
]

/**
 * Tramos con formato → árbol canónico: tramos contiguos con el mismo formato
 * comparten un único wrapper por tipo. `boldContext` indica que el bloque ya es
 * negrita (títulos), único caso donde "sin negrita" necesita marcado propio.
 */
export function richRunsToInline(runs: RichRun[], boldContext = false): RichInline[] {
  const formatted = runs.some((run) => run.type === "text")
  const build = (group: RichRun[], layer: number): RichInline[] => {
    const out: RichInline[] = []
    if (layer === LAYERS.length) {
      for (const run of group) {
        const last = out[out.length - 1]
        if (run.type === "br") out.push({ type: "br" })
        else if (last?.type === "text") out[out.length - 1] = { type: "text", text: last.text + run.text }
        else out.push({ type: "text", text: run.text })
      }
      return out
    }
    const wrapperOf = (run: RichRun) => formatted ? LAYERS[layer](run.marks, boldContext) : null
    let index = 0
    while (index < group.length) {
      const wrapper = wrapperOf(group[index])
      let end = index + 1
      while (end < group.length && wrapperOf(group[end])?.key === wrapper?.key) end += 1
      const inner = build(group.slice(index, end), layer + 1)
      if (wrapper) out.push(wrapper.wrap(inner))
      else out.push(...inner)
      index = end
    }
    return out
  }
  return build(runs, 0)
}

function blockTypeFor(name: string): RichBlockType {
  if (name === "h1" || name === "h2") return "h2"
  if (/^h[3-6]$/.test(name)) return "h3"
  return "p"
}

type DraftBlock =
  | { type: RichBlockType; runs: RichRun[]; align?: RichAlignment }
  | { type: "ul" | "ol"; items: RichRun[][]; align?: RichAlignment }

function htmlToBlocks(nodes: HtmlNode[]): RichBlock[] {
  const blocks: DraftBlock[] = []
  let pending: RichRun[] = []
  const flush = () => {
    if (hasVisibleRuns(pending)) blocks.push({ type: "p", runs: trimBreaks(pending) })
    pending = []
  }
  const inline = (node: HtmlNode, marks: RichMarks = {}): RichRun[] => {
    if (node.kind === "text") {
      const text = node.text.replace(ZERO_WIDTH_SPACE, "")
      return text ? [{ type: "text", text, marks }] : []
    }
    if (DROPPED_WITH_CONTENT.has(node.name)) return []
    if (node.name === "br") return [{ type: "br", marks }]
    const own = { ...marks, ...richMarksFromElement(node.name, node.attrs) }
    const children = node.children.flatMap((child): RichRun[] => {
      if (child.kind === "element" && BLOCK_ELEMENTS.has(child.name)) {
        return [{ type: "br", marks: own }, ...child.children.flatMap((grandchild) => inline(grandchild, own))]
      }
      return inline(child, own)
    })
    // Un formato sobre texto invisible no aporta nada: se descarta.
    return hasVisibleRuns(children) ? children : children.map((run) => ({ ...run, marks }))
  }
  const walk = (node: HtmlNode) => {
    if (node.kind === "text") { pending.push(...inline(node)); return }
    if (DROPPED_WITH_CONTENT.has(node.name)) return
    if (node.name === "ul" || node.name === "ol") {
      flush()
      const items = node.children
        .filter((child): child is Extract<HtmlNode, { kind: "element" }> => child.kind === "element" && child.name === "li")
        .map((item) => trimBreaks(item.children.flatMap((child) => inline(child))))
      if (items.length) blocks.push({ type: node.name, items, align: alignmentFromAttributes(node.attrs) })
      return
    }
    if (node.name === "p" || /^h[1-6]$/.test(node.name) || node.name === "li") {
      flush()
      const type = blockTypeFor(node.name)
      const align = alignmentFromAttributes(node.attrs)
      const nestedBlocks = node.children.some((child) => child.kind === "element" && BLOCK_ELEMENTS.has(child.name) && child.name !== "br")
      if (nestedBlocks) {
        let part: RichRun[] = []
        const pushPart = () => {
          if (hasVisibleRuns(part)) blocks.push({ type, runs: trimBreaks(part), align })
          part = []
        }
        for (const child of node.children) {
          if (child.kind === "element" && BLOCK_ELEMENTS.has(child.name) && child.name !== "br") {
            pushPart()
            walk(child)
          } else part.push(...inline(child))
        }
        pushPart()
      } else {
        const runs = node.children.flatMap((child) => inline(child))
        blocks.push({ type, runs: type === "p" ? runs : trimBreaks(runs), align })
      }
      return
    }
    if (BLOCK_ELEMENTS.has(node.name)) {
      flush()
      for (const child of node.children) walk(child)
      flush()
      return
    }
    pending.push(...inline(node))
  }
  for (const node of nodes) walk(node)
  flush()
  const visible = blocks.some((block) => "items" in block
    ? block.items.some(hasVisibleRuns)
    : hasVisibleRuns(block.runs))
  if (!visible) return []
  return blocks.map((block): RichBlock => "items" in block
    ? { type: block.type, items: block.items.map((item) => richRunsToInline(item)), align: block.align }
    : { type: block.type, children: richRunsToInline(block.runs, block.type !== "p"), align: block.align })
}

function trimBreaks<T extends { type: string }>(nodes: T[]) {
  let start = 0
  let end = nodes.length
  while (start < end && nodes[start].type === "br") start += 1
  while (end > start && nodes[end - 1].type === "br") end -= 1
  return nodes.slice(start, end)
}

function plainTextToBlocks(text: string): RichBlock[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => ({
      type: "p" as const,
      children: paragraph.split("\n").flatMap((line, index): RichInline[] =>
        index === 0 ? [{ type: "text", text: line }] : [{ type: "br" }, { type: "text", text: line }],
      ),
    }))
}

/** Descripción → bloques seguros. Acepta HTML del editor o texto plano legacy. */
export function parseRichDescription(value: string | null | undefined): RichBlock[] {
  const input = (value ?? "").slice(0, RICH_DESCRIPTION_MAX_LENGTH)
  if (!input.trim()) return []
  return HTML_HINT.test(input) ? htmlToBlocks(parseHtml(input)) : plainTextToBlocks(input)
}

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function serializeRichInline(nodes: RichInline[]): string {
  return nodes.map((node) => {
    switch (node.type) {
      case "text": return escapeHtml(node.text)
      case "br": return "<br>"
      case "weight-normal": return `<span class="rt-weight-normal">${serializeRichInline(node.children)}</span>`
      case "size": return `<span class="rt-size-${node.size}">${serializeRichInline(node.children)}</span>`
      case "font": return `<span class="rt-font-${node.font}">${serializeRichInline(node.children)}</span>`
      case "color": return `<span class="rt-color-${node.color}">${serializeRichInline(node.children)}</span>`
      default: return `<${node.type}>${serializeRichInline(node.children)}</${node.type}>`
    }
  }).join("")
}

/** HTML canónico y seguro para persistir ("" si no hay texto visible). */
export function sanitizeRichDescription(value: string | null | undefined) {
  return parseRichDescription(value)
    .map((block) => {
      const align = block.align && block.align !== "left" ? ` class="rt-align-${block.align}"` : ""
      if (block.type === "ul" || block.type === "ol") {
        return `<${block.type}${align}>${block.items.map((item) => `<li>${serializeRichInline(item)}</li>`).join("")}</${block.type}>`
      }
      // Un párrafo vacío entre bloques representa un Enter adicional. El <br>
      // mantiene su altura y cursor al volver a cargarlo en contentEditable.
      return `<${block.type}${align}>${block.type === "p" && block.children.length === 0 ? "<br>" : serializeRichInline(block.children)}</${block.type}>`
    })
    .join("")
}

function inlineText(nodes: RichInline[]): string {
  return nodes.map((node) =>
    node.type === "text" ? node.text : node.type === "br" ? "\n" : inlineText(node.children),
  ).join("")
}

export class RichDescriptionInputError extends Error {}

/**
 * Entrada de descripción para persistir (server-side, fuente definitiva):
 * string → HTML canónico de la allowlist (o null si no hay texto visible);
 * null/ausente → null. Cualquier otro tipo o un texto desmedido se rechaza en
 * vez de truncarse en silencio.
 */
export function normalizeProductDescriptionInput(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "string") throw new RichDescriptionInputError("La descripción no es válida.")
  if (value.length > RICH_DESCRIPTION_MAX_LENGTH) {
    throw new RichDescriptionInputError("La descripción es demasiado larga.")
  }
  return sanitizeRichDescription(value) || null
}

/** Texto plano (requisitos de activación, metadatos, búsqueda). */
export function richDescriptionToPlainText(value: string | null | undefined) {
  return parseRichDescription(value).map((block) => block.type === "ul" || block.type === "ol"
    ? block.items.map((item) => inlineText(item).trim()).join("\n")
    : inlineText(block.children).trim()).join("\n\n")
}

/** Tope del HTML de portapapeles: Word agrega hojas de estilo enormes antes del texto. */
const PASTE_HTML_MAX_LENGTH = 2_000_000

function pastedInlineText(nodes: RichInline[]): string {
  return nodes.map((node) => node.type === "text"
    ? node.text.replace(/[ \t\r\n\f]+/g, " ")
    : node.type === "br" ? "\n" : pastedInlineText(node.children)).join("")
}

/**
 * Contenido del portapapeles → texto sin ningún formato externo (fuente,
 * tamaño, peso, color, fondo, clases). Conserva párrafos, saltos y listas
 * simples como líneas; el editor lo inserta con el formato del cursor.
 */
export function richPasteToPlainText(html: string, plain: string) {
  const source = html.slice(0, PASTE_HTML_MAX_LENGTH)
  const blocks = HTML_HINT.test(source) ? htmlToBlocks(parseHtml(source)) : []
  // En HTML el espacio alrededor de bloques y saltos no es visible: se recorta.
  const text = blocks.length
    ? blocks.flatMap((block) => block.type === "ul" || block.type === "ol"
      ? block.items.map((item, index) => `${block.type === "ul" ? "•" : `${index + 1}.`} ${pastedInlineText(item).trim()}`)
      : [pastedInlineText(block.children)]).join("\n").split("\n").map((line) => line.trim()).join("\n")
    : plain.replace(/\r\n?/g, "\n").replace(ZERO_WIDTH_SPACE, "")
  // Como máximo una línea vacía seguida; sin líneas vacías al principio o al final.
  return text.replace(/\n(?:[ \t]*\n){2,}/g, "\n\n").replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, "")
}
