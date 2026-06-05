import Link from "next/link"

export function BeyonixLogoLink() {
  return (
    <Link
      href="/"
      aria-label="Ir al inicio de Beyonix"
      title="Ir al inicio de Beyonix"
      className="shrink-0 cursor-pointer font-heading text-2xl font-bold uppercase tracking-tight text-white transition-colors hover:text-white/90 lg:text-26px"
    >
      BEYONIX
    </Link>
  )
}
