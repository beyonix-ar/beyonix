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

type InlineFormat = "strong" | "em" | "u"

// Word y Google Docs marcan negrita/cursiva/subrayado con estilos inline. Se
// traducen a las etiquetas permitidas; el resto del estilo se descarta.
function formatsFromStyle(style: string | undefined): InlineFormat[] {
  if (!style) return []
  const declarations = new Map<string, string>()
  for (const declaration of style.split(";")) {
    const separator = declaration.indexOf(":")
    if (separator > 0) {
      declarations.set(declaration.slice(0, separator).trim().toLowerCase(), declaration.slice(separator + 1).trim().toLowerCase())
    }
  }
  const formats: InlineFormat[] = []
  const weight = declarations.get("font-weight")
  if (weight && (/^bold(er)?$/.test(weight) || Number(weight) >= 600)) formats.push("strong")
  if (/^(italic|oblique)\b/.test(declarations.get("font-style") ?? "")) formats.push("em")
  if (/\bunderline\b/.test(`${declarations.get("text-decoration") ?? ""} ${declarations.get("text-decoration-line") ?? ""}`)) formats.push("u")
  return formats
}

// Google Docs envuelve todo lo copiado en <b style="font-weight:normal">.
function isNormalWeight(style: string | undefined) {
  return /font-weight\s*:\s*(normal|[1-5]00)\b/i.test(style ?? "")
}

function hasVisibleContent(nodes: RichInline[]): boolean {
  return nodes.some((node) =>
    node.type === "text" ? node.text.trim() !== "" : node.type !== "br" && hasVisibleContent(node.children),
  )
}

function blockTypeFor(name: string): RichBlockType {
  if (name === "h1" || name === "h2") return "h2"
  if (/^h[3-6]$/.test(name)) return "h3"
  return "p"
}

function htmlToBlocks(nodes: HtmlNode[]): RichBlock[] {
  const blocks: RichBlock[] = []
  let pending: RichInline[] = []
  const flush = () => {
    if (hasVisibleContent(pending)) blocks.push({ type: "p", children: trimBreaks(pending) })
    pending = []
  }
  const inline = (node: HtmlNode): RichInline[] => {
    if (node.kind === "text") return node.text ? [{ type: "text", text: node.text }] : []
    if (DROPPED_WITH_CONTENT.has(node.name)) return []
    if (node.name === "br") return [{ type: "br" }]
    const children = node.children.flatMap((child) => {
      if (child.kind === "element" && BLOCK_ELEMENTS.has(child.name)) {
        return [{ type: "br" } as RichInline, ...child.children.flatMap(inline)]
      }
      return inline(child)
    })
    if (!hasVisibleContent(children)) return children
    const formats = formatsFromStyle(node.attrs.style)
    if ((node.name === "strong" || node.name === "b") && !isNormalWeight(node.attrs.style)) formats.push("strong")
    else if (node.name === "em" || node.name === "i") formats.push("em")
    else if (node.name === "u") formats.push("u")
    let wrapped: RichInline[] = children
    for (const format of [...new Set(formats)].reverse()) wrapped = [{ type: format, children: wrapped }]
    if (/font-weight\s*:\s*(normal|[1-5]00)\b/i.test(node.attrs.style ?? "") ||
      /(?:^|\s)rt-weight-normal(?:\s|$)/.test(node.attrs.class ?? "")) {
      wrapped = [{ type: "weight-normal", children: wrapped }]
    }
    if (node.name === "span" || node.name === "font") {
      const size = sizeFromAttributes(node.name, node.attrs)
      const font = fontFromAttributes(node.name, node.attrs)
      const color = colorFromAttributes(node.name, node.attrs)
      if (size) wrapped = [{ type: "size", size, children: wrapped }]
      if (font) wrapped = [{ type: "font", font, children: wrapped }]
      if (color) wrapped = [{ type: "color", color, children: wrapped }]
    }
    return wrapped
  }
  const walk = (node: HtmlNode) => {
    if (node.kind === "text") { pending.push(...inline(node)); return }
    if (DROPPED_WITH_CONTENT.has(node.name)) return
    if (node.name === "ul" || node.name === "ol") {
      flush()
      const items = node.children
        .filter((child): child is Extract<HtmlNode, { kind: "element" }> => child.kind === "element" && child.name === "li")
        .map((item) => trimBreaks(item.children.flatMap(inline)))
      if (items.length) blocks.push({ type: node.name, items, align: alignmentFromAttributes(node.attrs) })
      return
    }
    if (node.name === "p" || /^h[1-6]$/.test(node.name) || node.name === "li") {
      flush()
      const type = blockTypeFor(node.name)
      const align = alignmentFromAttributes(node.attrs)
      const nestedBlocks = node.children.some((child) => child.kind === "element" && BLOCK_ELEMENTS.has(child.name) && child.name !== "br")
      if (nestedBlocks) {
        let part: RichInline[] = []
        const pushPart = () => {
          if (hasVisibleContent(part)) blocks.push({ type, children: trimBreaks(part), align })
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
        const children = node.children.flatMap(inline)
        blocks.push({ type, children: type === "p" ? children : trimBreaks(children), align })
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
  const visible = blocks.some((block) => block.type === "ul" || block.type === "ol"
    ? block.items.some(hasVisibleContent)
    : hasVisibleContent(block.children))
  return visible ? blocks : []
}

function trimBreaks(nodes: RichInline[]) {
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

function serializeInline(nodes: RichInline[]): string {
  return nodes.map((node) => {
    switch (node.type) {
      case "text": return escapeHtml(node.text)
      case "br": return "<br>"
      case "weight-normal": return `<span class="rt-weight-normal">${serializeInline(node.children)}</span>`
      case "size": return `<span class="rt-size-${node.size}">${serializeInline(node.children)}</span>`
      case "font": return `<span class="rt-font-${node.font}">${serializeInline(node.children)}</span>`
      case "color": return `<span class="rt-color-${node.color}">${serializeInline(node.children)}</span>`
      default: return `<${node.type}>${serializeInline(node.children)}</${node.type}>`
    }
  }).join("")
}

/** HTML canónico y seguro para persistir ("" si no hay texto visible). */
export function sanitizeRichDescription(value: string | null | undefined) {
  return parseRichDescription(value)
    .map((block) => {
      const align = block.align && block.align !== "left" ? ` class="rt-align-${block.align}"` : ""
      if (block.type === "ul" || block.type === "ol") {
        return `<${block.type}${align}>${block.items.map((item) => `<li>${serializeInline(item)}</li>`).join("")}</${block.type}>`
      }
      // Un párrafo vacío entre bloques representa un Enter adicional. El <br>
      // mantiene su altura y cursor al volver a cargarlo en contentEditable.
      return `<${block.type}${align}>${block.type === "p" && block.children.length === 0 ? "<br>" : serializeInline(block.children)}</${block.type}>`
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
