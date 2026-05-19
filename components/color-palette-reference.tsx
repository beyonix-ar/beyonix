function getColorClass(colorName: string) {
  const colorMap: Record<string, string> = {
    negro: "bg-black",
    blanco: "bg-white",
    gris: "bg-gray-500",
    grisClaro: "bg-gray-300",
    grisOscuro: "bg-gray-700",
    azul: "bg-blue-600",
    azulClaro: "bg-blue-400",
    azulOscuro: "bg-blue-900",
    celeste: "bg-sky-400",
    turquesa: "bg-cyan-400",
    beyonixBlue: "bg-beyonixBlue",
    rojo: "bg-red-500",
    verde: "bg-green-500",
    rosa: "bg-pink-500",
    menta: "bg-emerald-300",
    beige: "bg-stone-300",
    titanio: "bg-zinc-500",
  }

  return colorMap[colorName] || "bg-zinc-500"
}

export default function ColorPaletteReference() {
  const colors = [
    ["negro", "#000000"],
    ["blanco", "#FFFFFF"],
    ["gris", "#6B7280"],
    ["grisClaro", "#D1D5DB"],
    ["grisOscuro", "#374151"],
    ["azul", "#2563EB"],
    ["azulClaro", "#60A5FA"],
    ["azulOscuro", "#1E3A8A"],
    ["celeste", "#38BDF8"],
    ["turquesa", "#22D3EE"],
    ["beyonixBlue", "#112A43"],
    ["rojo", "#EF4444"],
    ["verde", "#22C55E"],
    ["rosa", "#EC4899"],
    ["menta", "#6EE7B7"],
    ["beige", "#D6D3D1"],
    ["titanio", "#71717A"],
  ]

  return (
    <div className="rounded-2xl bg-black p-6">
      <h2 className="mb-6 text-2xl font-bold text-white">
        Paleta de colores Beyonix
      </h2>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-6">
        {colors.map(([name, hex]) => (
          <div
            key={name}
            className="rounded-xl border border-zinc-800 bg-zinc-950 p-3"
          >
            <div className="h-14 rounded-lg border border-zinc-700">
              <div
                className={`h-full w-full rounded-lg ${getColorClass(name)}`}
              />
            </div>

            <p className="mt-2 text-sm text-white">{name}</p>
            <p className="text-xs text-zinc-400">{hex}</p>
          </div>
        ))}
      </div>
    </div>
  )
}