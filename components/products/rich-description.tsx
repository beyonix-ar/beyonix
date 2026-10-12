import { Fragment, type ReactNode } from "react"

import type { RichAlignment, RichBlock, RichInline, RichTextColor, RichTextFont, RichTextSize } from "@/lib/products/rich-description"

const SIZE_CLASS: Record<RichTextSize, string> = {
  12: "text-[12px]", 14: "text-[14px]", 16: "text-[16px]", 18: "text-[18px]",
  20: "text-[20px]", 22: "text-[22px]", 24: "text-[24px]", 28: "text-[28px]",
  32: "text-[32px]", 36: "text-[36px]", 40: "text-[40px]",
}
const ALIGN_CLASS: Record<RichAlignment, string> = { left: "text-left", center: "text-center", right: "text-right" }
const FONT_CLASS: Record<RichTextFont, string> = {
  arial: "rt-font-arial", calibri: "rt-font-calibri", verdana: "rt-font-verdana", "comic-sans": "rt-font-comic-sans",
}
const COLOR_CLASS: Record<RichTextColor, string> = {
  black: "rt-color-black", white: "rt-color-white", gray: "rt-color-gray",
  "beyonix-blue": "rt-color-beyonix-blue", sky: "rt-color-sky", green: "rt-color-green",
  red: "rt-color-red", amber: "rt-color-amber",
}

function renderInline(nodes: RichInline[]): ReactNode {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text": return <Fragment key={index}>{node.text}</Fragment>
      case "br": return <br key={index} />
      case "weight-normal": return <span key={index} className="rt-weight-normal">{renderInline(node.children)}</span>
      case "strong": return <strong key={index} className="font-bold">{renderInline(node.children)}</strong>
      case "em": return <em key={index}>{renderInline(node.children)}</em>
      case "u": return <u key={index}>{renderInline(node.children)}</u>
      case "size": return <span key={index} className={SIZE_CLASS[node.size]}>{renderInline(node.children)}</span>
      case "font": return <span key={index} className={FONT_CLASS[node.font]}>{renderInline(node.children)}</span>
      case "color": return <span key={index} className={COLOR_CLASS[node.color]}>{renderInline(node.children)}</span>
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
      return <h3 key={index} className={`mt-3 text-2xl font-bold leading-tight first:mt-0 ${align}`}>{children}</h3>
    }
    if (block.type === "h3") {
      return <h4 key={index} className={`mt-2.5 text-lg font-semibold leading-7 first:mt-0 ${align}`}>{children}</h4>
    }
    return <p key={index} className={`mt-2 min-h-[1em] first:mt-0 ${align}`}>{children}</p>
  })
}
