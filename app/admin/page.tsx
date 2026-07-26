import { Suspense } from "react"

import { AdminClient } from "./admin-client"

function AdminBootstrapFallback() {
  return (
    <div className="min-h-screen bg-black text-white lg:grid lg:grid-cols-[254px_minmax(0,1fr)]">
      <aside className="hidden border-r border-beyonix-blue-light/18 bg-[#050B12] p-5 lg:block">
        <div className="h-16 animate-pulse rounded-2xl bg-white/4" />
        <div className="mt-5 h-24 animate-pulse rounded-2xl bg-white/4" />
        <div className="mt-7 space-y-3">
          {Array.from({ length: 7 }, (_, index) => (
            <div key={index} className="h-14 animate-pulse rounded-2xl bg-white/4" />
          ))}
        </div>
      </aside>
      <main className="p-5 sm:p-7">
        <div className="mx-auto max-w-1600px space-y-5">
          <div className="h-28 animate-pulse rounded-3xl border border-white/8 bg-white/3" />
          <div className="grid gap-4 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="h-32 animate-pulse rounded-3xl border border-white/8 bg-white/3" />
            ))}
          </div>
          <div className="h-80 animate-pulse rounded-3xl border border-white/8 bg-white/3" />
        </div>
      </main>
    </div>
  )
}

export default function AdminPage() {
  return (
    <Suspense fallback={<AdminBootstrapFallback />}>
      <AdminClient />
    </Suspense>
  )
}
