"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { AlignCenter, AlignLeft, AlignRight, Bold, Italic, List, ListOrdered, Redo2, Underline, Undo2 } from "lucide-react"
import { RICH_TEXT_SIZES, sanitizeRichDescription, type RichTextSize } from "@/lib/products/rich-description"
import { AdminSecondaryButton } from "../../components/admin-controls"

type Block = "p" | "h2" | "h3"
type ToolbarState = { block: Block; size: RichTextSize | null; bold: boolean; italic: boolean; underline: boolean; list: "ul" | "ol" | null; align: "left" | "center" | "right" }
const INITIAL: ToolbarState = { block: "p", size: 16, bold: false, italic: false, underline: false, list: null, align: "left" }

function inside(editor: HTMLElement, node: Node | null) {
  return Boolean(node && (node === editor || editor.contains(node)))
}

function sizeAt(node: Node | null, editor: HTMLElement): RichTextSize {
  for (let current = node; current && current !== editor; current = current.parentNode) {
    if (!(current instanceof HTMLElement)) continue
    const face = current.tagName === "FONT" ? current.getAttribute("face") : null
    const found = /^rt-size-(\d+)$/.exec(face ?? "")?.[1]
      ?? [...current.classList].map((name) => /^rt-size-(\d+)$/.exec(name)?.[1]).find(Boolean)
    if (found && RICH_TEXT_SIZES.includes(Number(found) as RichTextSize)) return Number(found) as RichTextSize
    if (current.tagName === "H2") return 24
    if (current.tagName === "H3") return 18
  }
  return 16
}

function selectedSize(editor: HTMLElement, range: Range): RichTextSize | null {
  if (range.collapsed) {
    const pending = /^rt-size-(\d+)$/.exec(String(document.queryCommandValue("fontName") || ""))?.[1]
    if (pending && RICH_TEXT_SIZES.includes(Number(pending) as RichTextSize)) return Number(pending) as RichTextSize
    return sizeAt(range.startContainer, editor)
  }
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
  const sizes = new Set<RichTextSize>()
  while (walker.nextNode()) {
    const node = walker.currentNode
    if (node.textContent?.length && range.intersectsNode(node)) sizes.add(sizeAt(node, editor))
    if (sizes.size > 1) return null
  }
  return sizes.values().next().value ?? 16
}

function currentState(editor: HTMLElement, range: Range): ToolbarState {
  let blockElement: HTMLElement | null = null
  for (let node: Node | null = range.startContainer; node && node !== editor; node = node.parentNode) {
    if (node instanceof HTMLElement && /^(P|H2|H3|LI|UL|OL|DIV)$/.test(node.tagName)) { blockElement = node; break }
  }
  const list = blockElement?.closest("ul, ol")
  const aligned = blockElement?.closest("[class*='rt-align-'], [align], [style*='text-align']") ?? blockElement
  const align = aligned instanceof HTMLElement
    ? aligned.classList.contains("rt-align-center") || aligned.style.textAlign === "center" || aligned.getAttribute("align") === "center" ? "center"
      : aligned.classList.contains("rt-align-right") || aligned.style.textAlign === "right" || aligned.getAttribute("align") === "right" ? "right" : "left"
    : "left"
  const tag = blockElement?.tagName.toLowerCase()
  return { block: tag === "h2" || tag === "h3" ? tag : "p", size: selectedSize(editor, range),
    bold: document.queryCommandState("bold"), italic: document.queryCommandState("italic"),
    underline: document.queryCommandState("underline"),
    list: list?.tagName === "UL" ? "ul" : list?.tagName === "OL" ? "ol" : null, align }
}

function Button({ label, active, action, children }: { label: string; active?: boolean; action: () => void; children: ReactNode }) {
  return <AdminSecondaryButton type="button" size="sm" title={label} aria-label={label} aria-pressed={active}
    onMouseDown={(event) => event.preventDefault()} onClick={action}
    className={`min-w-8 px-2 text-xs font-black ${active ? "border-sky-400/60 bg-sky-400/15 text-sky-100" : ""}`}>{children}</AdminSecondaryButton>
}

/** El navegador mantiene el historial de edición; cliente y servidor sanean el HTML. */
export function RichDescriptionEditor({ id, value, onChange, placeholder }: {
  id?: string; value: string; onChange: (value: string) => void; placeholder?: string
}) {
  const editorRef = useRef<HTMLDivElement>(null)
  const rangeRef = useRef<Range | null>(null)
  const lastRef = useRef<string | null>(null)
  const [state, setState] = useState<ToolbarState>(INITIAL)

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || value === lastRef.current) return
    editor.innerHTML = sanitizeRichDescription(value)
    lastRef.current = value
  }, [value])

  const updateState = useCallback(() => {
    const editor = editorRef.current
    const selection = window.getSelection()
    if (!editor || !selection?.rangeCount || !inside(editor, selection.anchorNode) || !inside(editor, selection.focusNode)) return
    const range = selection.getRangeAt(0)
    rangeRef.current = range.cloneRange()
    setState(currentState(editor, range))
  }, [])

  useEffect(() => {
    document.addEventListener("selectionchange", updateState)
    return () => document.removeEventListener("selectionchange", updateState)
  }, [updateState])

  const emit = () => {
    const editor = editorRef.current
    if (!editor) return
    const html = sanitizeRichDescription(editor.innerHTML)
    if (html !== lastRef.current) { lastRef.current = html; onChange(html) }
    updateState()
  }
  const restore = () => {
    const editor = editorRef.current
    if (!editor) return false
    editor.focus()
    const range = rangeRef.current
    if (range && inside(editor, range.startContainer) && inside(editor, range.endContainer)) {
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
    return true
  }
  const run = (command: string, argument?: string) => {
    if (!restore()) return
    const pendingSize = rangeRef.current?.collapsed && state.size !== null && state.size !== 16 ? state.size : null
    document.execCommand("styleWithCSS", false, "false")
    document.execCommand(command, false, argument)
    if (pendingSize && (command === "bold" || command === "italic" || command === "underline")) {
      document.execCommand("fontName", false, `rt-size-${pendingSize}`)
    }
    emit()
  }
  const setSize = (size: RichTextSize) => run("fontName", `rt-size-${size}`)
  const step = (direction: 1 | -1) => {
    const index = RICH_TEXT_SIZES.indexOf(state.size ?? 16)
    setSize(RICH_TEXT_SIZES[Math.max(0, Math.min(RICH_TEXT_SIZES.length - 1, index + direction))])
  }
  const clear = () => {
    if (!restore()) return
    document.execCommand("removeFormat")
    document.execCommand("formatBlock", false, "p")
    document.execCommand("justifyLeft")
    emit()
  }

  return <div className="product-rich-description-editor min-w-0 overflow-hidden rounded-xl border border-white/10">
    <div role="toolbar" aria-label="Formato de la descripción" className="flex flex-wrap items-center gap-1 border-b border-white/10 p-1.5">
      <select aria-label="Tipo de bloque" title="Tipo de bloque" value={state.block} onPointerDown={updateState}
        onChange={(event) => run("formatBlock", event.target.value)}
        className="h-8 min-w-24 rounded-md border border-white/15 bg-slate-900 px-1.5 text-xs font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-sky-400">
        <option value="p">Párrafo</option><option value="h2">Título</option><option value="h3">Subtítulo</option>
      </select>
      <select aria-label="Tamaño de letra" title="Tamaño de letra" value={state.size ?? "mixed"} onPointerDown={updateState}
        onChange={(event) => setSize(Number(event.target.value) as RichTextSize)}
        className="h-8 w-16 rounded-md border border-white/15 bg-slate-900 px-1 text-xs font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-sky-400">
        <option value="mixed" disabled>—</option>
        {RICH_TEXT_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
      </select>
      <Button label="Achicar texto" action={() => step(-1)}>A−</Button>
      <Button label="Agrandar texto" action={() => step(1)}>A+</Button>
      <span className="mx-0.5 h-5 w-px bg-white/15" aria-hidden="true" />
      <Button label="Negrita" active={state.bold} action={() => run("bold")}><Bold className="size-4" /></Button>
      <Button label="Subrayado" active={state.underline} action={() => run("underline")}><Underline className="size-4" /></Button>
      <Button label="Cursiva" active={state.italic} action={() => run("italic")}><Italic className="size-4" /></Button>
      <span className="mx-0.5 h-5 w-px bg-white/15" aria-hidden="true" />
      <Button label="Lista con viñetas" active={state.list === "ul"} action={() => run("insertUnorderedList")}><List className="size-4" /></Button>
      <Button label="Lista numerada" active={state.list === "ol"} action={() => run("insertOrderedList")}><ListOrdered className="size-4" /></Button>
      <span className="mx-0.5 h-5 w-px bg-white/15" aria-hidden="true" />
      <Button label="Alinear a la izquierda" active={state.align === "left"} action={() => run("justifyLeft")}><AlignLeft className="size-4" /></Button>
      <Button label="Centrar" active={state.align === "center"} action={() => run("justifyCenter")}><AlignCenter className="size-4" /></Button>
      <Button label="Alinear a la derecha" active={state.align === "right"} action={() => run("justifyRight")}><AlignRight className="size-4" /></Button>
      <span className="mx-0.5 h-5 w-px bg-white/15" aria-hidden="true" />
      <Button label="Deshacer" action={() => run("undo")}><Undo2 className="size-4" /></Button>
      <Button label="Rehacer" action={() => run("redo")}><Redo2 className="size-4" /></Button>
      <Button label="Limpiar formato" action={clear}>Limpiar</Button>
    </div>
    <div id={id} ref={editorRef} role="textbox" aria-multiline="true" aria-label="Descripción del producto"
      contentEditable suppressContentEditableWarning data-rich-editor data-placeholder={placeholder}
      onFocus={() => { document.execCommand("defaultParagraphSeparator", false, "p"); updateState() }}
      onInput={emit} onBlur={emit} onKeyUp={updateState} onMouseUp={updateState}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault()
          document.execCommand(event.shiftKey ? "insertLineBreak" : "insertParagraph")
          emit()
        }
      }}
      onPaste={(event) => {
        event.preventDefault()
        const html = sanitizeRichDescription(event.clipboardData.getData("text/html"))
        if (html) document.execCommand("insertHTML", false, html)
        else document.execCommand("insertText", false, event.clipboardData.getData("text/plain"))
        emit()
      }}
      onDrop={(event) => event.preventDefault()}
      className="box-border min-h-40 max-h-[32rem] overflow-y-auto break-words px-3 py-2.5 text-base leading-7 text-white outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-400"
    />
  </div>
}
