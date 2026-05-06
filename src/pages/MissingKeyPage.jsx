import { useAuth } from '../contexts/AuthContext';

export default function MissingKeyPage() {
  const { signOut } = useAuth();
  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center',
      justifyContent: 'center', padding: 24, background: 'var(--bg-0)'
    }}>
      <div style={{
        maxWidth: 440, background: 'var(--bg-1)',
        border: '1px solid rgba(255,68,102,0.3)',
        borderRadius: 'var(--radius-lg)', padding: '36px 32px',
        textAlign: 'center', animation: 'fadeIn 0.3s ease both'
      }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>🔐</div>
        <h2 style={{
          fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 700,
          marginBottom: 12, color: 'var(--danger)'
        }}>
          Key Unwrap Failed
        </h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.7, marginBottom: 24 }}>
          Your private key could not be decrypted. This usually means your password was incorrect,
          or the key data was corrupted. Please sign out and try again.
        </p>
        <button
          onClick={signOut}
          style={{
            background: 'var(--bg-3)', color: 'var(--text-primary)',
            fontFamily: 'var(--font-mono)', fontSize: 13,
            padding: '10px 24px', borderRadius: 'var(--radius-sm)',
            cursor: 'pointer', border: '1px solid var(--border)',
          }}
        >
          Sign out & try again
        </button>
      </div>
    </div>
  );
}
