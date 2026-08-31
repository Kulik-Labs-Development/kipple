import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react'

type FieldProps = InputHTMLAttributes<HTMLInputElement> & { label: string }

export function Field({ label, type, ...rest }: FieldProps) {
  const shared =
    'w-full border border-line bg-panel px-3 py-2 text-sm text-fg outline-none placeholder:text-dim focus:border-accent'
  return (
    <label className="block">
      <span className="mb-1 block text-xs uppercase tracking-widest text-dim">{label}</span>
      {type === 'textarea' ? (
        <textarea {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)} className={shared} />
      ) : (
        <input type={type} {...rest} className={shared} />
      )}
    </label>
  )
}
