import Link from "next/link"

export function BeyonixLogoLink() {
  return (
    <Link
      href="/"
      aria-label="Ir al inicio de Beyonix"
      className="beyonix-site-header-logo relative inline-flex w-fit shrink-0 cursor-pointer rounded-sm font-heading text-2xl font-bold uppercase tracking-tight text-white outline-none [text-shadow:0_0_4px_rgba(215,236,255,0.18),0_0_10px_rgba(74,144,184,0.12)] transition-all duration-300 after:absolute after:-bottom-1 after:left-0 after:right-0 after:h-px after:origin-center after:scale-x-0 after:bg-[rgba(191,228,255,0.38)] after:opacity-0 after:shadow-[0_0_6px_rgba(96,165,250,0.12)] after:transition-all after:duration-300 hover:text-white hover:opacity-90 hover:[text-shadow:0_0_5px_rgba(215,236,255,0.22),0_0_14px_rgba(96,165,250,0.14)] hover:after:scale-x-100 hover:after:opacity-100 focus-visible:opacity-90 focus-visible:ring-2 focus-visible:ring-beyonix-blue-light/25 lg:text-26px"
    >
      BEYONIX
    </Link>
  )
}
