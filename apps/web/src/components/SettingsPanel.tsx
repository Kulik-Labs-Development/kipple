import { useEffect, useRef, useState } from 'react'
import { api, type MeUser } from '../lib/api'

const inputClass =
  'w-full border border-line bg-panel px-2 py-1 text-xs text-fg outline-none focus:border-accent'
const labelClass = 'mb-1 block text-xs uppercase tracking-widest text-dim'
const buttonClass =
  'border border-accent px-3 py-1 text-xs uppercase tracking-widest text-accent hover:bg-accent hover:text-ink disabled:opacity-50'
const dimButtonClass =
  'border border-line px-3 py-1 text-xs uppercase tracking-widest text-dim hover:border-danger hover:text-danger'

export function SettingsPanel({
  user,
  ssoEnabled,
  onProfileSaved,
  onClose,
}: {
  user: MeUser
  ssoEnabled: boolean
  onProfileSaved: (patch: { name?: string; email?: string }) => void
  onClose: () => void
}) {
  const [name, setName] = useState(user.name)
  const [email, setEmail] = useState(user.email)
  const [phone, setPhone] = useState(user.phone ?? '')
  const [address, setAddress] = useState(user.address ?? '')
  const [office, setOffice] = useState(user.office ?? '')
  const [profileBusy, setProfileBusy] = useState(false)
  const [profileNote, setProfileNote] = useState<string | null>(null)

  const [hasAvatar, setHasAvatar] = useState(user.image !== null)
  const [avatarBusy, setAvatarBusy] = useState(false)
  const [avatarNote, setAvatarNote] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [passwordNote, setPasswordNote] = useState<string | null>(null)

  // Self-service magic-link login (issue #98): staff only, off by default,
  // hidden entirely when org-wide SSO is on (the section is not rendered).
  const [magicLink, setMagicLink] = useState(user.magicLinkEnabled)
  const [magicLinkBusy, setMagicLinkBusy] = useState(false)
  const [magicLinkNote, setMagicLinkNote] = useState<string | null>(null)

  useEffect(() => {
    setPasswordNote(null)
  }, [currentPassword, newPassword, confirmPassword])

  async function saveProfile() {
    setProfileBusy(true)
    setProfileNote(null)
    try {
      const res = await api.patchProfile({
        name,
        email,
        phone: phone || null,
        address: address || null,
        office: office || null,
      })
      onProfileSaved({ name: res.profile.name, email: res.profile.email })
      setProfileNote('saved')
    } catch (err) {
      setProfileNote(err instanceof Error ? err.message : 'saving the profile failed')
    } finally {
      setProfileBusy(false)
    }
  }

  async function pickAvatar(file: File) {
    setAvatarBusy(true)
    setAvatarNote(null)
    try {
      await api.uploadAvatar(file)
      setHasAvatar(true)
      setAvatarNote('uploaded')
    } catch (err) {
      setAvatarNote(err instanceof Error ? err.message : 'uploading the avatar failed')
    } finally {
      setAvatarBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function removeAvatar() {
    setAvatarBusy(true)
    setAvatarNote(null)
    try {
      await api.deleteAvatar()
      setHasAvatar(false)
      setAvatarNote('removed')
    } catch (err) {
      setAvatarNote(err instanceof Error ? err.message : 'removing the avatar failed')
    } finally {
      setAvatarBusy(false)
    }
  }

  async function changePassword() {
    if (newPassword.length < 8) {
      setPasswordNote('new password must be at least 8 characters')
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordNote('new password and confirmation do not match')
      return
    }
    setPasswordBusy(true)
    setPasswordNote(null)
    try {
      await api.changePassword({ currentPassword, newPassword })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setPasswordNote('password changed')
    } catch (err) {
      setPasswordNote(err instanceof Error ? err.message : 'changing the password failed')
    } finally {
      setPasswordBusy(false)
    }
  }

  async function saveMagicLink(enabled: boolean) {
    setMagicLinkBusy(true)
    setMagicLinkNote(null)
    try {
      await api.setMagicLink(enabled)
      setMagicLink(enabled)
      setMagicLinkNote(enabled ? 'enabled' : 'disabled')
    } catch (err) {
      setMagicLinkNote(err instanceof Error ? err.message : 'saving magic-link settings failed')
    } finally {
      setMagicLinkBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onMouseDown={onClose}
    >
      <div
        className="max-h-full w-full max-w-lg overflow-y-auto border border-line bg-ink"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="text-sm tracking-widest text-accent">settings</div>
          <button onClick={onClose} className={dimButtonClass}>
            close
          </button>
        </header>

        <div className="space-y-6 p-4">
          <section className="space-y-3">
            <div className="flex items-center gap-3">
              {hasAvatar ? (
                <img
                  src="/api/me/avatar"
                  alt="profile picture"
                  className="h-12 w-12 rounded-full border border-line object-cover"
                  onError={() => setHasAvatar(false)}
                />
              ) : (
                <span className="grid h-12 w-12 place-items-center rounded-full border border-line text-xs uppercase tracking-widest text-dim">
                  {user.name.slice(0, 1) || '?'}
                </span>
              )}
              <div className="flex gap-2">
                <button onClick={() => fileRef.current?.click()} disabled={avatarBusy} className={buttonClass}>
                  {hasAvatar ? 'replace picture' : 'upload picture'}
                </button>
                {hasAvatar && (
                  <button onClick={() => void removeAvatar()} disabled={avatarBusy} className={dimButtonClass}>
                    remove
                  </button>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0]
                    if (file) void pickAvatar(file)
                  }}
                />
              </div>
            </div>
            {avatarNote && <p className="text-xs text-dim">{avatarNote}</p>}
            <p className="text-xs text-dim">png, jpeg, webp or gif — max 2 MB.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-xs uppercase tracking-widest text-dim">profile</h2>
            <div>
              <label className={labelClass}>name</label>
              <input value={name} onChange={(event) => setName(event.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>email</label>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>phone</label>
              <input value={phone} onChange={(event) => setPhone(event.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>address</label>
              <input value={address} onChange={(event) => setAddress(event.target.value)} className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>primary office</label>
              <input value={office} onChange={(event) => setOffice(event.target.value)} className={inputClass} />
            </div>
            <div className="flex items-center gap-3">
              <button onClick={() => void saveProfile()} disabled={profileBusy} className={buttonClass}>
                save profile
              </button>
              {profileNote && <p className="text-xs text-dim">{profileNote}</p>}
            </div>
          </section>

          <section className="space-y-3 border-t border-line pt-4">
            <h2 className="text-xs uppercase tracking-widest text-dim">password</h2>
            <div>
              <label className={labelClass}>current password</label>
              <input
                type="password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>new password</label>
              <input
                type="password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>confirm new password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                className={inputClass}
              />
            </div>
            <div className="flex items-center gap-3">
              <button onClick={() => void changePassword()} disabled={passwordBusy} className={buttonClass}>
                change password
              </button>
              {passwordNote && <p className="text-xs text-dim">{passwordNote}</p>}
            </div>
          </section>

          {user.role !== 'contact' && !ssoEnabled && (
            <section className="space-y-3 border-t border-line pt-4">
              <h2 className="text-xs uppercase tracking-widest text-dim">magic link login</h2>
              <p className="text-xs text-dim">
                Sign in to the agent workspace with an email link instead of your password. Off by
                default.
              </p>
              <label className="flex items-center gap-2 text-xs text-fg">
                <input
                  type="checkbox"
                  checked={magicLink}
                  disabled={magicLinkBusy}
                  onChange={(event) => void saveMagicLink(event.target.checked)}
                />
                enable magic-link sign in
              </label>
              {magicLinkNote && <p className="text-xs text-dim">{magicLinkNote}</p>}
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
