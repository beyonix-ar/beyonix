import type { DispatchBatch } from "@/lib/admin/dispatch"

// Vista previa en pantalla. La impresión usa lib/barcodes (A4 o térmica).
export function DispatchLabel({ batch, barcodeUrl }: { batch: DispatchBatch; barcodeUrl: string | null }) {
  return (
    <div id="dispatch-print-label" className="dispatch-label-preview w-full max-w-sm rounded-xl border p-4 text-center sm:p-5">
      <span className="block text-xs font-bold tracking-widest">Bulto general</span>
      <strong className="mt-2 block break-all font-mono text-lg">{batch.code}</strong>
      {barcodeUrl ? (
        <div className="dispatch-label-barcode mt-3 bg-white p-2">
          {/* El SVG autenticado se carga como Blob local. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img alt={`Código de barras Code 128 de ${batch.code}`} src={barcodeUrl} className="mx-auto block w-full" />
        </div>
      ) : <p className="my-3 text-xs">Cargando código de barras…</p>}
    </div>
  )
}
