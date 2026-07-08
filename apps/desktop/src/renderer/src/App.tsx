import { ticketBranchName } from '@volli/shared'

function App() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '0.75rem',
        width: '100vw',
        height: '100vh',
        margin: 0,
        background: '#111111',
        color: '#f5f5f5',
        fontFamily: 'system-ui, sans-serif',
        fontSize: '2rem'
      }}
    >
      Volli Code
      <span style={{ fontSize: '0.9rem', color: '#E8652A', fontFamily: 'monospace' }}>
        {ticketBranchName('VC-0', 'monorepo migration')}
      </span>
    </div>
  )
}

export default App
