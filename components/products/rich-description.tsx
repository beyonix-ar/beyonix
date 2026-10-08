import { Fragment, type ReactNode } from "react"

import type { RichBlock, RichInline, RichTextSize } from "@/lib/products/rich-description"

const SIZE_CLASS: Record<RichTextSize, string> = {
  sm: "text-[0.875em]",
  lg: "text-[1.15em]",
  xl: "text-[1.3em]",
}

function renderInline(nodes: RichInline[]): ReactNode {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text": return <Fragment key={index}>{node.text}</Fragment>
      case "br": return <br key={index} />
      case "strong": return <strong key={index} className="font-bold text-white">{renderInline(node.children)}</strong>
      case "em": return <em key={index}>{renderInline(node.children)}</em>
      case "u": return <u key={index}>{renderInline(node.children)}</u>
      case "size": return <span key={index} className={SIZE_CLASS[node.size]}>{renderInline(node.children)}</span>
    }
  })
}

/**
 * Descripción enriquecida ya parseada (allowlist). Se renderiza como
 * elementos React: el texto siempre se escapa, nunca se usa innerHTML.
 */
export function RichDescription({ blocks }: { blocks: RichBlock[] }) {
  return blocks.map((block, index) => {
    const children = renderInline(block.children)
    if (block.type === "h2") {
      return <h3 key={index} className="mt-3 text-lg font-bold leading-7 text-white first:mt-0">{children}</h3>
    }
    if (block.type === "h3") {
      return <h4 key={index} className="mt-2.5 text-base font-semibold leading-7 text-white first:mt-0">{children}</h4>
    }
    return <p key={index} className="mt-2 first:mt-0">{children}</p>
  })
}
