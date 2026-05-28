"use client"

import { ProductSpecification } from "./product-details"

interface ProductSpecsProps {
  specifications: ProductSpecification[]
}

export function ProductSpecs({ specifications }: ProductSpecsProps) {
  return (
    <div>
      <p className="mb-3 text-10px uppercase tracking-widest font-medium text-white/55">
        Especificaciones
      </p>

      <div className="rounded-lg border border-white/10 overflow-hidden">
        {specifications.map((spec, index) => (
          <div
            key={`${spec.label}-${index}`}
            className={`flex items-center justify-between px-4 py-2.5 transition-colors hover:bg-white/4 ${
              index !== specifications.length - 1
                ? "border-b border-white/8"
                : ""
            }`}
          >
            <span className="text-12px text-white/65">
              {spec.label}
            </span>
            <span className="text-12px font-medium text-white/85">
              {spec.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}