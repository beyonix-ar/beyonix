import Link from "next/link"

export function BeyonixLogoLink() {
  return (
    <Link
      href="/"
      aria-label="Ir al inicio de Beyonix"
      className="relative inline-flex w-fit shrink-0 cursor-pointer font-heading text-2xl font-bold uppercase tracking-tight text-[#FFFFFF] [text-shadow:0_0_10px_rgba(17,42,67,0.78),0_0_24px_rgba(42,101,153,0.34)] transition-all duration-300 after:absolute after:-bottom-1 after:left-0 after:right-0 after:h-px after:origin-center after:scale-x-0 after:bg-[rgba(191,228,255,0.48)] after:opacity-0 after:shadow-[0_0_12px_rgba(96,165,250,0.22)] after:transition-all after:duration-300 hover:text-[#FFFFFF] hover:[text-shadow:0_0_12px_rgba(17,42,67,0.92),0_0_30px_rgba(59,130,246,0.34),0_0_5px_rgba(215,236,255,0.22)] hover:after:scale-x-100 hover:after:opacity-100 lg:text-26px"
    >
      BEYONIX
    </Link>
  )
}
