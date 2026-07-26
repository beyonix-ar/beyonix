export default function AdminLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Cargando sección administrativa"
      className="mx-auto w-full max-w-1600px space-y-5 px-4 py-6 sm:px-6 lg:px-8"
    >
      <div className="h-28 animate-pulse rounded-3xl border border-white/8 bg-white/3" />
      <div className="grid gap-4 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <div
            key={index}
            className="h-32 animate-pulse rounded-3xl border border-white/8 bg-white/3"
          />
        ))}
      </div>
      <div className="h-80 animate-pulse rounded-3xl border border-white/8 bg-white/3" />
    </div>
  )
}
