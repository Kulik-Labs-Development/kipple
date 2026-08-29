import { consoleTheme, fontMono } from '@kipple/ui'

export default function App() {
  return (
    <main
      style={{
        minHeight: '100vh',
        margin: 0,
        display: 'grid',
        placeItems: 'center',
        background: consoleTheme.background,
        color: consoleTheme.text,
        fontFamily: fontMono,
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ letterSpacing: '0.25em', color: consoleTheme.accent }}>KIPPLE</h1>
        <p style={{ color: consoleTheme.textDim }}>agent workspace · coming online</p>
      </div>
    </main>
  )
}
