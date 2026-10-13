"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { AlignCenter, AlignLeft, AlignRight, Bold, Italic, List, ListOrdered, Redo2, Underline, Undo2 } from "lucide-react"
import {
  RICH_TEXT_COLORS, RICH_TEXT_SIZES, richMarksFromElement, richPasteToPlainText, richRunsToInline, sanitizeRichDescription,
  serializeRichInline, type RichMarks, type RichRun, type RichTextColor, type RichTextFont, type RichTextSize,
} from "@/lib/products/rich-description"
import { AdminSecondaryButton, AdminSelect } from "../../components/admin-controls"

type ToolbarState = { size: RichTextSize | null; font: RichTextFont | "default" | null; color: RichTextColor | "auto" | null; bold: boolean; italic: boolean; underline: boolean; list: "ul" | "ol" | null; align: "left" | "center" | "right" }
const INITIAL: ToolbarState = { size: 16, font: "default", color: "auto", bold: false, italic: false, underline: false, list: null, align: "left" }

/** Marca de cursor: un formato elegido sin selección se aplica a este carácter invisible y el texto nuevo lo hereda. */
const CARET_MARK = "​"
const BLOCK_TAGS = /^(P|DIV|H[1-6]|LI|UL|OL|BLOCKQUOTE|PRE|SECTION|ARTICLE|TABLE|TBODY|THEAD|TR|TD|TH)$/
const BLOCK_SELECTOR = "p, div, h1, h2, h3, h4, h5, h6, li, ul, ol, blockquote, pre, section, article, table"
const NAVIGATION_KEYS = new Set(["Backspace", "Delete", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"])
const HISTORY_LIMIT = 100
const TYPING_MERGE_MS = 1000

type Snapshot = { html: string; start: number; end: number }
type EditKind = "insert" | "delete" | "action"
type History = { entries: Snapshot[]; index: number; typingAt: number; kind: EditKind }

function isBlock(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && BLOCK_TAGS.test(node.tagName)
}

function inside(editor: HTMLElement, node: Node | null) {
  return Boolean(node && (node === editor || editor.contains(node)))
}

function attributesOf(element: Element) {
  const attrs: Record<string, string> = {}
  for (const { name, value } of element.attributes) attrs[name.toLowerCase()] = value
  return attrs
}

function blockOf(node: Node, editor: HTMLElement) {
  for (let current: Node | null = node; current && current !== editor; current = current.parentNode) {
    if (isBlock(current)) return current
  }
  return null
}

function headingLevel(block: HTMLElement | null) {
  return block && /^H[1-6]$/.test(block.tagName) ? Number(block.tagName[1]) : null
}

/** Formato de los ancestros inline de `node` hasta su bloque; el más interno gana. */
function inheritedMarks(node: Node, editor: HTMLElement): RichMarks {
  const chain: Element[] = []
  for (let current = node.parentNode; current && current !== editor && !isBlock(current); current = current.parentNode) {
    if (current instanceof Element) chain.unshift(current)
  }
  return chain.reduce<RichMarks>((marks, element) => ({ ...marks, ...richMarksFromElement(element.tagName.toLowerCase(), attributesOf(element)) }), {})
}

type ResolvedMarks = { size: RichTextSize; font: RichTextFont | "default"; color: RichTextColor | "auto"; bold: boolean; italic: boolean; underline: boolean }

function resolvedMarks(marks: RichMarks, block: HTMLElement | null): ResolvedMarks {
  const heading = headingLevel(block)
  return {
    size: marks.size ?? (heading === null ? 16 : heading <= 2 ? 24 : 18),
    font: marks.font ?? "default", color: marks.color ?? "auto",
    bold: marks.bold ?? heading !== null, italic: marks.italic ?? false, underline: marks.underline ?? false,
  }
}

function marksAt(node: Node, editor: HTMLElement): ResolvedMarks {
  const own = node instanceof Element ? richMarksFromElement(node.tagName.toLowerCase(), attributesOf(node)) : {}
  const block = node instanceof HTMLElement && isBlock(node) ? node : blockOf(node, editor)
  return resolvedMarks(isBlock(node) ? {} : { ...inheritedMarks(node, editor), ...own }, block)
}

function unitsOf(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue?.length ?? 0
  if (!(node instanceof Element)) return 0
  if (node.tagName === "BR") return 1
  let total = isBlock(node) ? 1 : 0
  for (const child of node.childNodes) total += unitsOf(child)
  return total
}

/**
 * Posición lineal estable: caracteres + 1 por <br> + 1 por fin de bloque. El
 * formato reconstruye nodos sin cambiar texto, saltos ni bloques, así que una
 * selección guardada así sobrevive a la reconstrucción y al historial.
 */
function pointToUnits(editor: HTMLElement, node: Node, offset: number) {
  let total = 0
  const visit = (current: Node): boolean => {
    if (current === node) {
      if (current.nodeType === Node.TEXT_NODE) total += offset
      else for (let index = 0; index < offset && index < current.childNodes.length; index += 1) total += unitsOf(current.childNodes[index])
      return true
    }
    if (current.nodeType === Node.TEXT_NODE || (current instanceof Element && current.tagName === "BR")) {
      total += unitsOf(current)
      return false
    }
    for (const child of current.childNodes) if (visit(child)) return true
    if (current !== editor && isBlock(current)) total += 1
    return false
  }
  visit(editor)
  return total
}

function unitsToPoint(editor: HTMLElement, target: number): { node: Node; offset: number } {
  let total = 0
  const visit = (parent: Node): { node: Node; offset: number } | null => {
    for (let index = 0; index < parent.childNodes.length; index += 1) {
      const child = parent.childNodes[index]
      if (child.nodeType === Node.TEXT_NODE) {
        const length = child.nodeValue?.length ?? 0
        if (target <= total + length) return { node: child, offset: target - total }
        total += length
      } else if (child instanceof Element && child.tagName === "BR") {
        if (target === total) return { node: parent, offset: index }
        total += 1
      } else if (child instanceof Element) {
        const found = visit(child)
        if (found) return found
        if (isBlock(child)) {
          if (target === total) return { node: child, offset: child.childNodes.length }
          total += 1
        }
      }
    }
    return null
  }
  return visit(editor) ?? { node: editor, offset: editor.childNodes.length }
}

function selectUnits(editor: HTMLElement, start: number, end: number) {
  const from = unitsToPoint(editor, start)
  const to = end === start ? from : unitsToPoint(editor, end)
  const range = document.createRange()
  range.setStart(from.node, from.offset)
  range.setEnd(to.node, to.offset)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  return range
}

/** Nodo de texto cuya marca de cursor sigue pendiente: el cursor está justo después de ella. */
function pendingCaretMark(range: Range | null) {
  if (!range?.collapsed) return null
  const { startContainer, startOffset } = range
  return startContainer.nodeType === Node.TEXT_NODE && startOffset > 0 && startContainer.nodeValue?.[startOffset - 1] === CARET_MARK
    ? startContainer : null
}

/**
 * Quita las marcas de cursor (salvo `keep`) conservando la selección. Así la
 * marca sólo existe mientras el formato está pendiente: al escribir, mover el
 * cursor o borrar desaparece y nunca cuesta una pulsación extra.
 */
function stripCaretMarks(editor: HTMLElement, keep: Node | null) {
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  const marked: Text[] = []
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (node !== keep && node.data.includes(CARET_MARK)) marked.push(node)
  }
  if (!marked.length) return
  const selection = window.getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null
  const tracked = range && inside(editor, range.startContainer) && inside(editor, range.endContainer)
  let start = tracked ? pointToUnits(editor, range.startContainer, range.startOffset) : 0
  let end = tracked ? pointToUnits(editor, range.endContainer, range.endOffset) : 0
  // De atrás hacia adelante: quitar una marca no mueve las posiciones anteriores.
  for (const node of marked.reverse()) {
    const base = pointToUnits(editor, node, 0)
    for (let index = node.data.length - 1; index >= 0; index -= 1) {
      if (node.data[index] !== CARET_MARK) continue
      if (start > base + index) start -= 1
      if (end > base + index) end -= 1
    }
    node.data = node.data.replaceAll(CARET_MARK, "")
    if (node.data) continue
    let empty: Node = node
    while (empty.parentNode && empty.parentNode !== editor && !isBlock(empty.parentNode) && empty.parentNode.childNodes.length === 1) empty = empty.parentNode
    const parent = empty.parentNode
    parent?.removeChild(empty)
    // Un bloque vacío necesita <br> para conservar altura y cursor.
    if (parent && parent !== editor && isBlock(parent) && !parent.childNodes.length) {
      parent.appendChild(document.createElement("br"))
      if (start > base) start += 1
      if (end > base) end += 1
    }
  }
  if (tracked) selectUnits(editor, start, end)
}

/** Secuencias de nodos inline hermanos; los bloques se recorren por dentro. */
function inlineGroups(parent: Node, out: Node[][] = []) {
  let group: Node[] = []
  for (const child of [...parent.childNodes]) {
    if (isBlock(child) || (child instanceof Element && child.querySelector(BLOCK_SELECTOR))) {
      if (group.length) out.push(group)
      group = []
      inlineGroups(child, out)
    } else group.push(child)
  }
  if (group.length) out.push(group)
  return out
}

function flattenDom(node: Node, marks: RichMarks, out: RichRun[]) {
  if (node.nodeType === Node.TEXT_NODE) {
    if (node.nodeValue) out.push({ type: "text", text: node.nodeValue, marks })
    return
  }
  if (!(node instanceof Element)) return
  if (node.tagName === "BR") { out.push({ type: "br", marks }); return }
  const next = { ...marks, ...richMarksFromElement(node.tagName.toLowerCase(), attributesOf(node)) }
  for (const child of node.childNodes) flattenDom(child, next, out)
}

type MarksChange = (marks: RichMarks) => RichMarks

/**
 * Reconstruye todo el formato inline del editor como HTML canónico. Los tramos
 * dentro de [start, end) reciben `change`: la elección del usuario reemplaza el
 * formato previo del rango en vez de anidarse debajo de estilos viejos.
 */
function normalizeEditor(editor: HTMLElement, start = 0, end = 0, change?: MarksChange) {
  for (const group of inlineGroups(editor)) {
    const parent = group[0].parentNode
    if (!parent) continue
    const block = blockOf(group[0], editor)
    const base = inheritedMarks(group[0], editor)
    const heading = headingLevel(block) !== null
    let position = pointToUnits(editor, parent, [...parent.childNodes].indexOf(group[0] as ChildNode))
    const runs: RichRun[] = []
    for (const node of group) flattenDom(node, {}, runs)
    const result: RichRun[] = []
    for (const run of runs) {
      const runEnd = position + (run.type === "text" ? run.text.length : 1)
      const clamp = (value: number) => Math.min(runEnd, Math.max(position, value))
      const cuts = change ? [position, clamp(start), clamp(end), runEnd] : [position, runEnd]
      for (let index = 0; index < cuts.length - 1; index += 1) {
        const [from, to] = [cuts[index], cuts[index + 1]]
        if (to <= from) continue
        const marks = change && from >= start && to <= end ? relativeMarks(change({ ...base, ...run.marks }), base) : run.marks
        result.push(run.type === "text" ? { type: "text", text: run.text.slice(from - position, to - position), marks } : { type: "br", marks })
      }
      position = runEnd
    }
    const template = document.createElement("template")
    template.innerHTML = serializeRichInline(richRunsToInline(result, heading || base.bold === true))
    const anchor = group[group.length - 1].nextSibling
    for (const node of group) node.parentNode?.removeChild(node)
    parent.insertBefore(template.content, anchor)
  }
}

function relativeMarks(next: RichMarks, base: RichMarks): RichMarks {
  const marks: RichMarks = {}
  if (next.size !== undefined && next.size !== base.size) marks.size = next.size
  if (next.font !== undefined && next.font !== base.font) marks.font = next.font
  if (next.color !== undefined && next.color !== base.color) marks.color = next.color
  if (next.bold !== undefined) marks.bold = next.bold
  if (next.italic) marks.italic = true
  if (next.underline) marks.underline = true
  return marks
}

/** Nodos de texto realmente cubiertos por el rango (sin marcas de cursor). */
function selectedTextNodes(editor: HTMLElement, range: Range) {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const text = node.data
    if (!text.replaceAll(CARET_MARK, "") || !range.intersectsNode(node)) continue
    if (node === range.startContainer && range.startOffset >= text.length) continue
    if (node === range.endContainer && range.endOffset === 0) continue
    nodes.push(node)
  }
  return nodes
}

function caretNode(range: Range) {
  const { startContainer: container, startOffset: offset } = range
  if (container.nodeType === Node.TEXT_NODE) return container
  return container.childNodes[offset - 1] ?? container.childNodes[offset] ?? container
}

function selectionMarks(editor: HTMLElement, range: Range): ResolvedMarks[] {
  if (range.collapsed) return [marksAt(caretNode(range), editor)]
  const nodes = selectedTextNodes(editor, range)
  return nodes.length ? nodes.map((node) => marksAt(node, editor)) : [marksAt(caretNode(range), editor)]
}

function common<T>(values: T[]): T | null {
  return values.every((value) => value === values[0]) ? values[0] : null
}

function currentState(editor: HTMLElement, range: Range): ToolbarState {
  const blockElement = blockOf(range.startContainer, editor)
  const list = blockElement?.closest("ul, ol")
  const aligned = blockElement?.closest("[class*='rt-align-'], [align], [style*='text-align']") ?? blockElement
  const align = aligned instanceof HTMLElement
    ? aligned.classList.contains("rt-align-center") || aligned.style.textAlign === "center" || aligned.getAttribute("align") === "center" ? "center"
      : aligned.classList.contains("rt-align-right") || aligned.style.textAlign === "right" || aligned.getAttribute("align") === "right" ? "right" : "left"
    : "left"
  const marks = selectionMarks(editor, range)
  return {
    size: common(marks.map((mark) => mark.size)), font: common(marks.map((mark) => mark.font)),
    color: common(marks.map((mark) => mark.color)),
    bold: marks.every((mark) => mark.bold), italic: marks.every((mark) => mark.italic), underline: marks.every((mark) => mark.underline),
    list: list?.tagName === "UL" ? "ul" : list?.tagName === "OL" ? "ol" : null, align,
  }
}

function Button({ label, active, action, children }: { label: string; active?: boolean; action: () => void; children: ReactNode }) {
  return <AdminSecondaryButton type="button" size="sm" title={label} aria-label={label} aria-pressed={active}
    onMouseDown={(event) => event.preventDefault()} onClick={action}
    className={`min-w-8 px-2 text-xs font-black ${active ? "border-sky-400/60 bg-sky-400/15 text-sky-100" : ""}`}>{children}</AdminSecondaryButton>
}

/**
 * El formato inline (fuente, tamaño, color, negrita, cursiva, subrayado) se
 * aplica sobre un modelo propio y se reescribe canónico; listas, alineación y
 * Enter siguen usando los comandos nativos. Como el DOM se reescribe, el
 * historial de deshacer es propio. Cliente y servidor sanean el HTML.
 */
export function RichDescriptionEditor({ id, value, onChange, placeholder }: {
  id?: string; value: string; onChange: (value: string) => void; placeholder?: string
}) {
  const editorRef = useRef<HTMLDivElement>(null)
  const rangeRef = useRef<Range | null>(null)
  const lastRef = useRef<string | null>(null)
  const historyRef = useRef<History>({ entries: [], index: 0, typingAt: 0, kind: "action" })
  const busyRef = useRef(false)
  const composingRef = useRef(false)
  const [state, setState] = useState<ToolbarState>(INITIAL)

  const snapshot = useCallback((): Snapshot => {
    const editor = editorRef.current!
    const selection = window.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    if (!range || !inside(editor, range.startContainer) || !inside(editor, range.endContainer)) return { html: editor.innerHTML, start: 0, end: 0 }
    return { html: editor.innerHTML, start: pointToUnits(editor, range.startContainer, range.startOffset), end: pointToUnits(editor, range.endContainer, range.endOffset) }
  }, [])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || value === lastRef.current) return
    editor.innerHTML = sanitizeRichDescription(value)
    lastRef.current = value
    historyRef.current = { entries: [{ html: editor.innerHTML, start: 0, end: 0 }], index: 0, typingAt: 0, kind: "action" }
  }, [value])

  const updateState = useCallback(() => {
    const editor = editorRef.current
    const selection = window.getSelection()
    if (!editor || !selection?.rangeCount || !inside(editor, selection.anchorNode) || !inside(editor, selection.focusNode)) return
    // El cursor se fue de una marca pendiente sin escribir: el formato pendiente se descarta.
    if (!composingRef.current) stripCaretMarks(editor, pendingCaretMark(selection.getRangeAt(0)))
    const range = selection.getRangeAt(0)
    rangeRef.current = range.cloneRange()
    setState(currentState(editor, range))
  }, [])

  useEffect(() => {
    document.addEventListener("selectionchange", updateState)
    return () => document.removeEventListener("selectionchange", updateState)
  }, [updateState])

  const publish = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const html = sanitizeRichDescription(editor.innerHTML)
    if (html !== lastRef.current) { lastRef.current = html; onChange(html) }
    updateState()
  }, [onChange, updateState])

  /**
   * Publica el valor y registra el estado en el historial. Como en Word, escribir
   * seguido o borrar seguido es un solo paso; cambiar entre escribir y borrar,
   * mover el cursor o aplicar formato empieza otro.
   */
  const emit = useCallback((kind: EditKind = "action") => {
    const editor = editorRef.current
    if (!editor) return
    const history = historyRef.current
    const now = Date.now()
    const entry = snapshot()
    if (entry.html !== history.entries[history.index]?.html) {
      const merge = kind !== "action" && kind === history.kind && history.index > 0 && now - history.typingAt < TYPING_MERGE_MS
      history.entries = history.entries.slice(0, merge ? history.index : history.index + 1)
      history.entries.push(entry)
      if (history.entries.length > HISTORY_LIMIT) history.entries.shift()
      history.index = history.entries.length - 1
    }
    history.kind = kind
    history.typingAt = kind === "action" ? 0 : now
    publish()
  }, [publish, snapshot])

  const travel = useCallback((step: -1 | 1) => {
    const editor = editorRef.current
    const history = historyRef.current
    const target = history.entries[history.index + step]
    if (!editor || !target) return
    history.index += step
    history.typingAt = 0
    editor.innerHTML = target.html
    editor.focus()
    rangeRef.current = selectUnits(editor, target.start, target.end).cloneRange()
    publish()
  }, [publish])

  const restore = () => {
    const editor = editorRef.current
    if (!editor) return null
    editor.focus()
    const range = rangeRef.current
    const selection = window.getSelection()
    if (range && inside(editor, range.startContainer) && inside(editor, range.endContainer)) {
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
    const current = selection?.rangeCount ? selection.getRangeAt(0) : null
    return current && inside(editor, current.startContainer) && inside(editor, current.endContainer) ? current : null
  }

  /** Comandos nativos programáticos: su evento input no se registra como tipeo. */
  const native = (command: string, argument?: string) => {
    busyRef.current = true
    try { document.execCommand(command, false, argument) } finally { busyRef.current = false }
  }

  const runNative = (command: string) => {
    if (!restore()) return
    native("styleWithCSS", "false")
    native(command)
    emit()
  }

  /** Aplica formato inline al rango; sin selección, deja una marca de cursor para el texto nuevo. */
  const format = (change: (marks: RichMarks, selected: ResolvedMarks[]) => RichMarks, after?: () => void) => {
    const editor = editorRef.current
    const range = restore()
    if (!editor || !range) return
    let start = pointToUnits(editor, range.startContainer, range.startOffset)
    let end = pointToUnits(editor, range.endContainer, range.endOffset)
    const collapsed = start === end
    if (collapsed) {
      const { startContainer, startOffset } = range
      const reuse = startContainer.nodeType === Node.TEXT_NODE && startOffset > 0 && startContainer.nodeValue?.[startOffset - 1] === CARET_MARK
      if (reuse) start -= 1
      else { range.insertNode(document.createTextNode(CARET_MARK)); end += 1 }
    }
    const selected = collapsed
      ? [marksAt(unitsToPoint(editor, end).node, editor)]
      : selectionMarks(editor, selectUnits(editor, start, end))
    normalizeEditor(editor, start, end, (marks) => change(marks, selected))
    rangeRef.current = selectUnits(editor, collapsed ? end : start, end).cloneRange()
    after?.()
    emit()
  }

  /** El menú devuelve el foco a su botón al cerrarse; se lo devolvemos al texto para seguir escribiendo con el formato elegido. */
  const fromMenu = (change: (marks: RichMarks) => RichMarks) => {
    format(change)
    window.setTimeout(() => {
      const editor = editorRef.current
      const range = rangeRef.current
      if (!editor || !range || !inside(editor, range.startContainer)) return
      editor.focus()
      window.getSelection()?.removeAllRanges()
      window.getSelection()?.addRange(range)
    }, 0)
  }
  const setSize = (size: RichTextSize) => fromMenu((marks) => ({ ...marks, size }))
  const setFont = (font: RichTextFont | "default") => fromMenu((marks) => ({ ...marks, font: font === "default" ? undefined : font }))
  const setColor = (color: RichTextColor | "auto") => fromMenu((marks) => ({ ...marks, color: color === "auto" ? undefined : color }))
  const toggle = (mark: "bold" | "italic" | "underline") => format((marks, selected) => ({ ...marks, [mark]: !selected.every((item) => item[mark]) }))
  const clear = () => format(() => ({}), () => {
    native("formatBlock", "p")
    native("justifyLeft")
  })

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    // Menú Editar del navegador / gestos del sistema: mismo historial y formato propio.
    const onBeforeInput = (event: InputEvent) => {
      if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
        event.preventDefault()
        travel(event.inputType === "historyUndo" ? -1 : 1)
      }
    }
    editor.addEventListener("beforeinput", onBeforeInput)
    return () => editor.removeEventListener("beforeinput", onBeforeInput)
  }, [travel])

  return <div className="product-rich-description-editor min-w-0 overflow-hidden rounded-xl border border-white/10">
    <div role="toolbar" aria-label="Formato de la descripción" onPointerDownCapture={updateState} className="flex flex-wrap items-center gap-1 border-b border-white/10 p-1.5">
      <AdminSelect title="Tamaño de letra" ariaLabel="Tamaño de letra" value={String(state.size ?? "mixed")}
        compact wrapperClassName="w-20 shrink-0" triggerClassName="product-rich-select" menuClassName="product-rich-select-menu" onChange={(next) => { if (next !== "mixed") setSize(Number(next) as RichTextSize) }}>
        <option value="mixed">—</option>
        {RICH_TEXT_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
      </AdminSelect>
      <AdminSelect title="Tipografía" ariaLabel="Tipografía" value={state.font ?? "mixed"}
        compact wrapperClassName="w-34 shrink-0" triggerClassName="product-rich-select" menuClassName="product-rich-select-menu" onChange={(next) => { if (next !== "mixed") setFont(next as RichTextFont | "default") }}>
        <option value="mixed">—</option>
        <option value="default">Montserrat</option><option value="arial">Arial</option><option value="calibri">Calibri</option>
        <option value="verdana">Verdana</option><option value="comic-sans">Comic Sans MS</option>
      </AdminSelect>
      <AdminSelect title="Color de texto" ariaLabel="Color de texto" value={state.color ?? "mixed"}
        compact wrapperClassName="w-34 shrink-0" triggerClassName="product-rich-select" menuClassName="product-rich-select-menu" onChange={(next) => { if (next !== "mixed") setColor(next as RichTextColor | "auto") }}>
        <option value="mixed">—</option><option value="auto">Automático</option>
        {RICH_TEXT_COLORS.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
      </AdminSelect>
      <span className="mx-0.5 h-5 w-px bg-white/15" aria-hidden="true" />
      <Button label="Negrita" active={state.bold} action={() => toggle("bold")}><Bold className="size-4" /></Button>
      <Button label="Subrayado" active={state.underline} action={() => toggle("underline")}><Underline className="size-4" /></Button>
      <Button label="Cursiva" active={state.italic} action={() => toggle("italic")}><Italic className="size-4" /></Button>
      <span className="mx-0.5 h-5 w-px bg-white/15" aria-hidden="true" />
      <Button label="Lista con viñetas" active={state.list === "ul"} action={() => runNative("insertUnorderedList")}><List className="size-4" /></Button>
      <Button label="Lista numerada" active={state.list === "ol"} action={() => runNative("insertOrderedList")}><ListOrdered className="size-4" /></Button>
      <span className="mx-0.5 h-5 w-px bg-white/15" aria-hidden="true" />
      <Button label="Alinear a la izquierda" active={state.align === "left"} action={() => runNative("justifyLeft")}><AlignLeft className="size-4" /></Button>
      <Button label="Centrar" active={state.align === "center"} action={() => runNative("justifyCenter")}><AlignCenter className="size-4" /></Button>
      <Button label="Alinear a la derecha" active={state.align === "right"} action={() => runNative("justifyRight")}><AlignRight className="size-4" /></Button>
      <span className="mx-0.5 h-5 w-px bg-white/15" aria-hidden="true" />
      <Button label="Deshacer" action={() => travel(-1)}><Undo2 className="size-4" /></Button>
      <Button label="Rehacer" action={() => travel(1)}><Redo2 className="size-4" /></Button>
      <Button label="Limpiar formato" action={clear}>Limpiar</Button>
    </div>
    <div id={id} ref={editorRef} role="textbox" aria-multiline="true" aria-label="Descripción del producto"
      contentEditable suppressContentEditableWarning data-rich-editor data-placeholder={placeholder}
      onFocus={() => { document.execCommand("defaultParagraphSeparator", false, "p"); updateState() }}
      onInput={(event) => {
        if (busyRef.current) return
        // El texto escrito ya quedó dentro del formato pendiente: la marca sobra.
        if (editorRef.current && !composingRef.current) stripCaretMarks(editorRef.current, null)
        emit((event.nativeEvent as InputEvent).inputType?.startsWith("delete") ? "delete" : "insert")
      }}
      onCompositionStart={() => { composingRef.current = true }}
      onCompositionEnd={() => {
        composingRef.current = false
        if (editorRef.current) stripCaretMarks(editorRef.current, null)
        emit("insert")
      }}
      onBlur={() => publish()} onKeyUp={updateState} onMouseUp={updateState}
      onKeyDown={(event) => {
        const key = event.key.toLowerCase()
        if ((event.ctrlKey || event.metaKey) && !event.altKey) {
          const shortcut = key === "z" ? (event.shiftKey ? "redo" : "undo") : key === "y" ? "redo"
            : key === "b" ? "bold" : key === "i" ? "italic" : key === "u" ? "underline" : null
          if (!shortcut) return
          event.preventDefault()
          updateState()
          if (shortcut === "undo" || shortcut === "redo") travel(shortcut === "undo" ? -1 : 1)
          else toggle(shortcut)
          return
        }
        // Borrar o mover el cursor actúa sobre el texto real, nunca sobre la marca pendiente.
        if (editorRef.current && NAVIGATION_KEYS.has(event.key)) {
          stripCaretMarks(editorRef.current, null)
          if (event.key !== "Backspace" && event.key !== "Delete") historyRef.current.typingAt = 0
        }
        if (event.key === "Enter") {
          event.preventDefault()
          native(event.shiftKey ? "insertLineBreak" : "insertParagraph")
          emit()
        }
      }}
      onPaste={(event) => {
        // Sólo texto: fuente, tamaño, color, fondo y clases ajenas nunca entran.
        event.preventDefault()
        const editor = editorRef.current
        const text = richPasteToPlainText(event.clipboardData.getData("text/html"), event.clipboardData.getData("text/plain"))
        if (!editor || !text) return
        text.split("\n").forEach((line, index) => {
          if (index > 0) native("insertParagraph")
          if (line) native("insertText", line)
        })
        stripCaretMarks(editor, null)
        const { start, end } = snapshot()
        normalizeEditor(editor)
        selectUnits(editor, start, end)
        emit()
      }}
      onDrop={(event) => event.preventDefault()}
      className="box-border min-h-40 max-h-[32rem] overflow-y-auto break-words px-3 py-2.5 text-base leading-7 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400"
    />
  </div>
}
