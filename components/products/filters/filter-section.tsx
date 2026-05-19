"use client"

import type { ReactNode } from "react"

interface FilterSectionProps {
  title: string
  children: ReactNode
}

export function FilterSection({
  title,
  children,
}: FilterSectionProps) {
  return (
    <div className="mb-8">
      <p className="mb-4 text-sm font-semibold text-white">
        {title}
      </p>
      {children}
    </div>
  )
}