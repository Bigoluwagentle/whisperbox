import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import styles from './AuthPage.module.css';

export default function AuthPage() {
  const [mode, setMode]         = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const { signIn, register }    = useAuth();
  const navigate                = useNavigate();

  const handle = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (mode === 'register') {
        setStatusMsg('Generating RSA-2048 key pair…');
        await new Promise(r => setTimeout(r, 50)); // let UI update
        setStatusMsg('Deriving PBKDF2 wrapping key…');
        await new Promise(r => setTimeout(r, 50));
        await register(username, password);
        setStatusMsg('');
      } else {
        setStatusMsg('Fetching encrypted key from server…');
        await new Promise(r => setTimeout(r, 50));
        setStatusMsg('Unwrapping private key with password…');
        await new Promise(r => setTimeout(r, 50));
        await signIn(username, password);
        setStatusMsg('');
      }
      navigate('/');
    } catch (err) {
      setError(err.message || 'Something went wrong');
      setStatusMsg('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.bg} />
      <div className={styles.card}>
        <div className={styles.logo}>
          <LockIcon />
          <span className={styles.logoText}>WhisperBox</span>
        </div>
        <p className={styles.tagline}>
          {mode === 'register'
            ? 'Your keys are generated on-device. The server only stores the encrypted form.'
            : 'Your private key is unwrapped from the server using your password — never transmitted in plaintext.'}
        </p>

        <div className={styles.tabs}>
          <button className={`${styles.tab} ${mode === 'login' ? styles.active : ''}`}
            onClick={() => { setMode('login'); setError(''); }}>Sign In</button>
          <button className={`${styles.tab} ${mode === 'register' ? styles.active : ''}`}
            onClick={() => { setMode('register'); setError(''); }}>Register</button>
        </div>

        <form onSubmit={handle} className={styles.form}>
          <div className={styles.field}>
            <label className={styles.label}>Username</label>
            <input className={styles.input} value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="enter username" autoComplete="username"
              required disabled={loading} />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Password</label>
            <input className={styles.input} type="password" value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="••••••••••"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              required disabled={loading} />
          </div>

          {error && (
            <div className={styles.error}><span>⚠</span> {error}</div>
          )}

          {statusMsg && (
            <div className={styles.status}>
              <span className={styles.spinner} />{statusMsg}
            </div>
          )}

          <button className={styles.submit} type="submit" disabled={loading}>
            {loading
              ? <><span className={styles.spinner} /> {mode === 'register' ? 'Creating…' : 'Signing in…'}</>
              : mode === 'register' ? 'Create Account' : 'Sign In'
            }
          </button>
        </form>

        {mode === 'register' && (
          <div className={styles.notice}>
            <InfoIcon />
            <span>
              Your RSA private key is wrapped with a PBKDF2-derived key (310,000 iterations) before being stored on the server.
              <strong style={{color:'var(--text-primary)'}}> Your password never leaves this device.</strong>
            </span>
          </div>
        )}

        {mode === 'login' && (
          <div className={styles.notice}>
            <InfoIcon />
            <span>
              Works on any device — the server stores your encrypted private key.
              Your password is used locally to unwrap it. It is never sent to the server.
            </span>
          </div>
        )}
      </div>
      <div className={styles.footer}>
        <span className="enc-badge"><span className="dot"></span>AES-256-GCM · RSA-OAEP · PBKDF2</span>
      </div>
    </div>
  );
}

function LockIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <rect x="4" y="12" width="20" height="14" rx="3" stroke="var(--accent)" strokeWidth="1.5"/>
      <path d="M9 12V8a5 5 0 0110 0v4" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round"/>
      <circle cx="14" cy="19" r="2" fill="var(--accent)"/>
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{flexShrink:0,marginTop:1}}>
      <circle cx="7" cy="7" r="6" stroke="var(--accent)" strokeWidth="1.2"/>
      <path d="M7 6v4M7 4.5v.5" stroke="var(--accent)" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  );
}
