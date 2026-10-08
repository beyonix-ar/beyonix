"use client"

import { useEffect, useRef, type ReactNode } from "react"
import { Bold, Heading2, Heading3, Italic, Underline } from "lucide-react"

import { sanitizeRichDescription } from "@/lib/products/rich-description"

import { AdminSecondaryButton } from "../../components/admin-controls"

// Niveles discretos de tamaño (execCommand fontSize 2..5 ↔ sm/base/lg/xl).
const SIZE_LEVELS = [2, 3, 4, 5] as const
const CLASS_TO_LEVEL: Record<string, number> = { "rt-size-sm": 2, "rt-size-lg": 4, "rt-size-xl": 5 }

function currentSizeLevel(root: HTMLElement) {
  let node = window.getSelection()?.anchorNode ?? null
  while (node && node !== root) {
    if (node instanceof HTMLElement) {
      if (node.tagName === "FONT" && node.getAttribute("size")) return Number(node.getAttribute("size"))
      const sized = [...node.classList].find((name) => name in CLASS_TO_LEVEL)
      if (sized) return CLASS_TO_LEVEL[sized]
    }
    node = node.parentNode
  }
  return 3
}

function selectionInside(root: HTMLElement) {
  const anchor = window.getSelection()?.anchorNode
  return Boolean(anchor && root.contains(anchor))
}

function ToolbarButton({ label, onAction, children }: { label: string; onAction: () => void; children: ReactNode }) {
  return (
    <AdminSecondaryButton
      size="sm"
      title={label}
      aria-label={label}
      // Sin preventDefault en mousedown el editor perdería la selección
      // antes del click (que también llega por teclado).
      onMouseDown={(event) => event.preventDefault()}
      onClick={onAction}
      className="min-w-8 px-2 text-xs font-black"
    >
      {children}
    </AdminSecondaryButton>
  )
}

/**
 * Editor de la descripción del producto. Enter = párrafo, Shift+Enter =
 * salto de línea. Lo pegado (Word, Google Docs, web) pasa por la misma
 * allowlist antes de entrar: sólo sobreviven negrita, cursiva, subrayado,
 * títulos, párrafos y saltos. Lo emitido también pasa siempre por
 * sanitizeRichDescription, y el servidor vuelve a sanear al guardar.
 *
 * Usa document.execCommand: está deprecado pero sigue soportado por todos los
 * navegadores y no hay reemplazo nativo; migrar a un editor completo
 * (TipTap/ProseMirror, Lexical) agrega una dependencia grande para cinco
 * comandos. Ver docs/product-description.md.
 */
export function RichDescriptionEditor({
  id,
  value,
  onChange,
  placeholder,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  const editorRef = useRef<HTMLDivElement>(null)
  const lastEmittedRef = useRef<string | null>(null)

  // Sólo se reescribe el DOM cuando el valor cambia desde afuera (carga o
  // reinicio del formulario); lo que tipea el admin no se re-renderiza.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || value === lastEmittedRef.current) return
    editor.innerHTML = sanitizeRichDescription(value)
    lastEmittedRef.current = value
  }, [value])

  const emit = () => {
    const editor = editorRef.current
    if (!editor) return
    const html = sanitizeRichDescription(editor.innerHTML)
    if (html === lastEmittedRef.current) return
    lastEmittedRef.current = html
    onChange(html)
  }

  const run = (command: string, argument?: string) => {
    const editor = editorRef.current
    if (!editor) return
    if (!selectionInside(editor)) editor.focus()
    document.execCommand("styleWithCSS", false, "false")
    document.execCommand(command, false, argument)
    emit()
  }

  const toggleBlock = (tag: "h2" | "h3") => {
    const current = String(document.queryCommandValue("formatBlock") || "").toLowerCase()
    run("formatBlock", current === tag ? "<p>" : `<${tag}>`)
  }

  const stepSize = (direction: 1 | -1) => {
    const editor = editorRef.current
    if (!editor) return
    const index = SIZE_LEVELS.indexOf(currentSizeLevel(editor) as (typeof SIZE_LEVELS)[number])
    const next = SIZE_LEVELS[Math.min(SIZE_LEVELS.length - 1, Math.max(0, (index < 0 ? 1 : index) + direction))]
    run("fontSize", String(next))
  }

  return (
    <div className="product-rich-description-editor min-w-0 overflow-hidden rounded-xl border border-white/10">
      <div role="toolbar" aria-label="Formato de la descripción" className="flex flex-wrap items-center gap-1.5 border-b border-white/8 p-1.5">
        <ToolbarButton label="Título" onAction={() => toggleBlock("h2")}>
          <Heading2 className="size-4" aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton label="Subtítulo" onAction={() => toggleBlock("h3")}>
          <Heading3 className="size-4" aria-hidden="true" />
        </ToolbarButton>
        <span className="mx-0.5 h-5 w-px bg-white/10" aria-hidden="true" />
        <ToolbarButton label="Negrita" onAction={() => run("bold")}>
          <Bold className="size-4" aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton label="Subrayado" onAction={() => run("underline")}>
          <Underline className="size-4" aria-hidden="true" />
        </ToolbarButton>
        <ToolbarButton label="Cursiva" onAction={() => run("italic")}>
          <Italic className="size-4" aria-hidden="true" />
        </ToolbarButton>
        <span className="mx-0.5 h-5 w-px bg-white/10" aria-hidden="true" />
        <ToolbarButton label="Achicar texto" onAction={() => stepSize(-1)}>A-</ToolbarButton>
        <ToolbarButton label="Agrandar texto" onAction={() => stepSize(1)}>A+</ToolbarButton>
      </div>
      <div
        id={id}
        ref={editorRef}
        role="textbox"
        aria-multiline="true"
        aria-label="Descripción del producto"
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onFocus={() => document.execCommand("defaultParagraphSeparator", false, "p")}
        onInput={emit}
        onBlur={emit}
        onPaste={(event) => {
          event.preventDefault()
          const html = sanitizeRichDescription(event.clipboardData.getData("text/html"))
          if (html) document.execCommand("insertHTML", false, html)
          else document.execCommand("insertText", false, event.clipboardData.getData("text/plain"))
          emit()
        }}
        onDrop={(event) => event.preventDefault()}
        className="min-h-40 max-w-none px-3 py-2.5 text-sm leading-6 text-white outline-none empty:before:pointer-events-none empty:before:text-white/40 empty:before:content-[attr(data-placeholder)] [&_b]:font-black [&_font[size='2']]:text-[0.875em] [&_font[size='4']]:text-[1.15em] [&_font[size='5']]:text-[1.3em] [&_h2]:mt-2 [&_h2]:text-lg [&_h2]:font-black [&_h3]:mt-2 [&_h3]:text-base [&_h3]:font-black [&_p+p]:mt-2 [&_strong]:font-black [&_.rt-size-sm]:text-[0.875em] [&_.rt-size-lg]:text-[1.15em] [&_.rt-size-xl]:text-[1.3em]"
      />
    </div>
  )
}
