import type { DispatchBatch } from "@/lib/admin/dispatch"

function dateTime(value: string | null) {
  return value ? new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—"
}

// Vista previa en pantalla. La impresión usa lib/barcodes (A4 o térmica).
export function DispatchLabel({ batch, barcodeUrl }: { batch: DispatchBatch; barcodeUrl: string | null }) {
  return (
    <div id="dispatch-print-label" className="max-w-sm rounded-xl border border-white/25 bg-white p-5 text-center text-black">
      <strong className="block text-xl tracking-wider">BEYONIX</strong>
      <span className="block text-xs font-bold tracking-widest">BULTO GENERAL</span>
      <strong className="mt-3 block text-lg">{batch.code}</strong>
      {barcodeUrl ? (
        // El SVG autenticado se carga como Blob local.
        // eslint-disable-next-line @next/next/no-img-element
        <img alt={`Código de barras Code 128 de ${batch.code}`} src={barcodeUrl} className="mx-auto my-3 w-full" />
      ) : <p className="my-3 text-xs">Cargando código de barras…</p>}
      <p className="text-xs">{dateTime(batch.closed_at)}</p>
    </div>
  )
}
