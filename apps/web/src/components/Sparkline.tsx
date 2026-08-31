// Minimal bar sparkline for the dashboard 14-day strip (item 11 stats).
export function Sparkline({
  label,
  values,
  barClass,
}: {
  label: string
  values: number[]
  barClass: string
}) {
  const max = Math.max(1, ...values)
  const total = values.reduce((a, b) => a + b, 0)
  return (
    <div className="flex items-end gap-2">
      <div className="flex items-end gap-[2px]" style={{ height: 24 }}>
        {values.map((value, index) => (
          <div
            key={index}
            title={`${value}`}
            className={`w-1 ${barClass} ${value === 0 ? 'opacity-20' : ''}`}
            style={{ height: `${Math.max(12, (value / max) * 100)}%` }}
          />
        ))}
      </div>
      <span className="text-xs uppercase tracking-widest text-dim">
        {label} <span className="text-fg tabular-nums">{total}</span>
      </span>
    </div>
  )
}
