"use client"

import { ProductSpecification } from "./product-details"

interface ProductSpecsProps {
  specifications: ProductSpecification[]
}

export function ProductSpecs({ specifications }: ProductSpecsProps) {
  return (
    <div>
      <p className="mb-3 text-[10px] uppercase tracking-[0.3em] font-medium text-white/45">
        Especificaciones
      </p>

      <div className="rounded-lg border border-white/[0.1] overflow-hidden">
        {specifications.map((spec, index) => (
          <div
            key={`${spec.label}-${index}`}
            className={`flex items-center justify-between px-4 py-2.5 transition-colors hover:bg-white/[0.04] ${
              index !== specifications.length - 1
                ? "border-b border-white/[0.08]"
                : ""
            }`}
          >
            <span className="text-[12px] text-white/55">
              {spec.label}
            </span>
            <span className="text-[12px] font-medium text-white/85">
              {spec.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}