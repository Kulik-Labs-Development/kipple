// Rich text editor for ticket updates (workspace + portal).
// Console-aesthetic toolbar; outputs sanitized-friendly HTML (the render side
// sanitizes — see lib/rich.ts). Images v1 = URL embeds; file uploads stay on
// the attachment chips (inline upload endpoint = follow-up).
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Placeholder from '@tiptap/extension-placeholder'
import { FontSize, FONT_SIZE_CLASSES } from '../lib/fontSize'

interface RichTextEditorProps {
  placeholder: string
  initialHtml?: string
  onHtmlChange: (html: string) => void
}

const btnBase =
  'border px-2 py-0.5 text-xs uppercase tracking-widest transition-colors hover:border-accent hover:text-accent'
const btnIdle = 'border-line text-dim'
const btnActive = 'border-accent text-accent'

export function RichTextEditor({
  placeholder,
  initialHtml = '',
  onHtmlChange,
}: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [
      // Link + Underline come from StarterKit in TipTap v3 — configure them
      // here instead of importing the extensions separately (duplicates).
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
        },
      }),
      Image,
      FontSize,
      Placeholder.configure({ placeholder }),
    ],
    content: initialHtml,
    onUpdate: ({ editor: e }) => onHtmlChange(e.getHTML()),
    editorProps: {
      attributes: { class: 'rich-editor-area' },
    },
  })

  if (!editor) return null

  const markClass = (active: boolean) => `${btnBase} ${active ? btnActive : btnIdle}`
  const mark = (label: string, title: string, active: boolean, onClick: () => void) => (
    <button type="button" title={title} onClick={onClick} className={markClass(active)}>
      {label}
    </button>
  )

  function toggleLink() {
    const previous = editor?.getAttributes('link').href as string | undefined
    const href = window.prompt('Link URL', previous ?? '')
    if (href === null) return
    if (href.trim() === '') {
      editor?.chain().focus().extendMarkRange('link').unsetMark('link').run()
      return
    }
    editor
      ?.chain()
      .focus()
      .extendMarkRange('link')
      .setLink({ href: href.trim(), target: '_blank' })
      .run()
  }

  function insertImage() {
    const src = window.prompt('Image URL')
    if (!src || !src.trim()) return
    const alt = window.prompt('Image description (alt text)') ?? ''
    editor?.chain().focus().setImage({ src: src.trim(), alt: alt.trim() }).run()
  }

  const activeSize = FONT_SIZE_CLASSES.find((c) => editor.isActive('fontSize', { class: c }))

  const separator = <span className="mx-1 h-4 w-px bg-line" />

  return (
    <div className="border border-line bg-ink focus-within:border-accent">
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1">
        {mark('b', 'Bold (Ctrl+B)', editor.isActive('bold'), () =>
          editor.chain().focus().toggleMark('bold').run(),
        )}
        {mark('i', 'Italic (Ctrl+I)', editor.isActive('italic'), () =>
          editor.chain().focus().toggleMark('italic').run(),
        )}
        {mark('s', 'Strikethrough', editor.isActive('strike'), () =>
          editor.chain().focus().toggleMark('strike').run(),
        )}
        {mark('u', 'Underline (Ctrl+U)', editor.isActive('underline'), () =>
          editor.chain().focus().toggleMark('underline').run(),
        )}
        {mark('</>', 'Inline code', editor.isActive('code'), () =>
          editor.chain().focus().toggleMark('code').run(),
        )}
        {separator}
        {mark('h1', 'Heading 1', editor.isActive('heading', { level: 1 }), () =>
          editor.chain().focus().setNode('heading', { level: 1 }).run(),
        )}
        {mark('h2', 'Heading 2', editor.isActive('heading', { level: 2 }), () =>
          editor.chain().focus().setNode('heading', { level: 2 }).run(),
        )}
        {mark('h3', 'Heading 3', editor.isActive('heading', { level: 3 }), () =>
          editor.chain().focus().setNode('heading', { level: 3 }).run(),
        )}
        {mark('¶', 'Paragraph', !editor.isActive('heading'), () =>
          editor.chain().focus().setNode('paragraph').run(),
        )}
        {separator}
        <select
          title="Font size"
          aria-label="Font size"
          value={activeSize ?? ''}
          onChange={(event) => {
            const value = event.target.value
            if (value) editor.chain().focus().setMark('fontSize', { class: value }).run()
            else editor.chain().focus().unsetMark('fontSize').run()
          }}
          className="border border-line bg-ink px-1 py-0.5 text-xs text-fg outline-none focus:border-accent"
        >
          <option value="">size</option>
          <option value="fs-sm">small</option>
          <option value="fs-base">normal</option>
          <option value="fs-lg">large</option>
          <option value="fs-xl">x-large</option>
        </select>
        {separator}
        {mark('•', 'Bullet list', editor.isActive('bulletList'), () =>
          editor.chain().focus().toggleBulletList().run(),
        )}
        {mark('1.', 'Numbered list', editor.isActive('orderedList'), () =>
          editor.chain().focus().toggleOrderedList().run(),
        )}
        {mark('❝', 'Quote', editor.isActive('blockquote'), () =>
          editor.chain().focus().toggleBlockquote().run(),
        )}
        {mark('```', 'Code block', editor.isActive('codeBlock'), () =>
          editor.chain().focus().toggleCodeBlock().run(),
        )}
        {separator}
        {mark('link', 'Link', editor.isActive('link'), toggleLink)}
        {mark('img', 'Image (URL)', editor.isActive('image'), insertImage)}
        {mark('―', 'Divider', false, () => editor.chain().focus().setHorizontalRule().run())}
        {separator}
        {mark('clear', 'Clear formatting', false, () =>
          editor.chain().focus().clearNodes().unsetAllMarks().run(),
        )}
        {mark('⟲', 'Undo (Ctrl+Z)', false, () => editor.chain().focus().undo().run())}
        {mark('⟳', 'Redo (Ctrl+Shift+Z)', false, () => editor.chain().focus().redo().run())}
      </div>
      <EditorContent editor={editor} />
    </div>
  )
}
