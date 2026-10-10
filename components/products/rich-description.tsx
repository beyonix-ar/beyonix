import { Fragment, type ReactNode } from "react"

import type { RichAlignment, RichBlock, RichInline, RichTextSize } from "@/lib/products/rich-description"

const SIZE_CLASS: Record<RichTextSize, string> = {
  12: "text-[12px]", 14: "text-[14px]", 16: "text-[16px]", 18: "text-[18px]",
  20: "text-[20px]", 22: "text-[22px]", 24: "text-[24px]", 28: "text-[28px]",
  32: "text-[32px]", 36: "text-[36px]", 40: "text-[40px]",
}
const ALIGN_CLASS: Record<RichAlignment, string> = { left: "text-left", center: "text-center", right: "text-right" }

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
    const align = ALIGN_CLASS[block.align ?? "left"]
    if (block.type === "ul" || block.type === "ol") {
      const List = block.type
      return <List key={index} className={`mt-2 list-outside pl-6 first:mt-0 ${block.type === "ul" ? "list-disc" : "list-decimal"} ${align}`}>
        {block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>)}
      </List>
    }
    const children = renderInline(block.children)
    if (block.type === "h2") {
      return <h3 key={index} className={`mt-3 text-2xl font-bold leading-tight text-white first:mt-0 ${align}`}>{children}</h3>
    }
    if (block.type === "h3") {
      return <h4 key={index} className={`mt-2.5 text-lg font-semibold leading-7 text-white first:mt-0 ${align}`}>{children}</h4>
    }
    return <p key={index} className={`mt-2 min-h-[1em] first:mt-0 ${align}`}>{children}</p>
  })
}
