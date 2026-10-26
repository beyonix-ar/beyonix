import Image from "next/image"
import { ImageIcon } from "lucide-react"

/** Miniatura de producto del Admin: fondo blanco cuando hay imagen (fotos sobre blanco). */
export function ProductThumbnail({
  image,
  alt,
  size = "md",
  tone = "normal",
}: {
  image: string | null
  alt: string
  size?: "sm" | "md"
  tone?: "normal" | "conditioned"
}) {
  return (
    <span
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-xl border ${
        image ? "bg-[#ffffff]" : "bg-black/30"
      } ${
        size === "sm" ? "size-9" : "size-10"
      } ${
        tone === "conditioned"
          ? "border-amber-300/25"
          : "border-white/10"
      }`}
    >
      {image ? (
        <Image
          src={image}
          alt={alt}
          fill
          sizes={size === "sm" ? "36px" : "40px"}
          className="object-cover"
        />
      ) : (
        <ImageIcon className="size-4 text-white/22" aria-hidden="true" />
      )}
    </span>
  )
}
