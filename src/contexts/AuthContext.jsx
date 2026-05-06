/**
 * AuthContext.jsx
 *
 * Key lifecycle:
 *  Register  → generate keypair → wrapPrivateKey (PBKDF2+AES-GCM) → POST /auth/register
 *              → saveSession (encrypted in IndexedDB, session AES key in sessionStorage)
 *
 *  Page refresh → restoreSession from IndexedDB (works as long as same tab/sessionStorage alive)
 *              → reconnect WebSocket
 *
 *  Login     → POST /auth/login → get wrapped_private_key from server
 *              → unwrapPrivateKey → saveSession
 *
 *  Logout    → clearSession → disconnect WS → clear tokens
 */

import {
  createContext, useContext, useState,
  useEffect, useRef, useCallback
} from 'react';
import * as api from '../utils/api';
import {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  generateSalt,
  deriveWrappingKey,
  wrapPrivateKey,
  unwrapPrivateKey,
} from '../utils/crypto';
import {
  saveSession,
  restoreSession,
  clearSession,
  saveLastUserId,
  getLastUserId,
  cachePublicKey,
  getCachedPublicKey,
} from '../utils/keyStore';
import { wsClient } from '../utils/wsClient';

const AuthContext = createContext(null);

// In-memory private key (also backed by IndexedDB session for refresh survival)
let _privateKey   = null;
let _publicKeyB64 = null;

export function AuthProvider({ children }) {
  const [user,     setUser]     = useState(null);
  const [keyReady, setKeyReady] = useState(false);
  const [loading,  setLoading]  = useState(true);
  const [wsStatus, setWsStatus] = useState('closed');
  const refreshTimer = useRef(null);

  // ── Start WebSocket + proactive token refresh ─────────────────────────────
  const startWS = useCallback(() => {
    wsClient.onStatusChange = setWsStatus;
    wsClient.connect();

    // Proactively refresh access token every 12 min (tokens expire at 15 min)
    clearTimeout(refreshTimer.current);
    const tick = async () => {
      try { await api.refreshToken(); } catch (_) {}
      refreshTimer.current = setTimeout(tick, 12 * 60 * 1000);
    };
    refreshTimer.current = setTimeout(tick, 12 * 60 * 1000);
  }, []);

  // ── Page load: try to restore session from IndexedDB ─────────────────────
  useEffect(() => {
    const restore = async () => {
      try {
        const userId = getLastUserId();
        if (!userId) { setLoading(false); return; }

        const session = await restoreSession(userId);
        if (!session) {
          // Session AES key gone (new tab or browser restart) — show login
          setLoading(false);
          return;
        }

        // Try to get a valid access token (auto-refresh if needed)
        const hasAccess = !!api.tokenStore.getAccess();
        if (!hasAccess) {
          // Try refresh
          try { await api.refreshToken(); }
          catch (_) { setLoading(false); return; }
        }

        // Fetch fresh user profile
        const me = await api.getMe();

        // Restore in-memory keys
        _privateKey   = session.privateKey;
        _publicKeyB64 = session.publicKeyB64;

        setUser(me);
        setKeyReady(true);
        startWS();
      } catch (e) {
        // Anything goes wrong → go to login
        api.tokenStore.clear();
      } finally {
        setLoading(false);
      }
    };
    restore();
    return () => clearTimeout(refreshTimer.current);
  }, [startWS]);

  // ── Register ──────────────────────────────────────────────────────────────
  const register = useCallback(async (username, password) => {
    // 1. Generate RSA-OAEP keypair
    const keyPair      = await generateKeyPair();
    const publicKeyB64 = await exportPublicKey(keyPair.publicKey);

    // 2. PBKDF2 → AES-GCM wrap private key for server storage
    const pbkdf2Salt      = generateSalt();
    const wrappingKey     = await deriveWrappingKey(password, pbkdf2Salt);
    const wrappedPrivKey  = await wrapPrivateKey(keyPair.privateKey, wrappingKey);

    // 3. POST /auth/register
    const data = await api.register({
      username,
      password,
      publicKey:         publicKeyB64,
      wrappedPrivateKey: wrappedPrivKey,
      pbkdf2Salt,
    });

    const me = data.user;
    if (!me) throw new Error('Register response missing user object');

    // 4. Save session to IndexedDB + sessionStorage (survives refresh)
    _privateKey   = keyPair.privateKey;
    _publicKeyB64 = publicKeyB64;
    await saveSession(me.id, keyPair.privateKey, publicKeyB64, me);
    await cachePublicKey(me.id, publicKeyB64);
    saveLastUserId(me.id);

    setUser(me);
    setKeyReady(true);
    startWS();
    return me;
  }, [startWS]);

  // ── Login ─────────────────────────────────────────────────────────────────
  const signIn = useCallback(async (username, password) => {
    // POST /auth/login → { access_token, refresh_token, user: { wrapped_private_key, pbkdf2_salt, ... } }
    const data = await api.login(username, password);
    const me   = data.user;
    if (!me) throw new Error('Login response missing user object');

    const wrappedPrivateKey = me.wrapped_private_key;
    const pbkdf2Salt        = me.pbkdf2_salt;
    const publicKeyB64      = me.public_key;

    if (!wrappedPrivateKey || !pbkdf2Salt) {
      throw new Error('Server did not return key material.');
    }

    // Re-derive wrapping key from password + salt, unwrap private key
    const wrappingKey = await deriveWrappingKey(password, pbkdf2Salt);
    const privateKey  = await unwrapPrivateKey(wrappedPrivateKey, wrappingKey);

    // Cache public key
    let pubB64 = publicKeyB64 || (await getCachedPublicKey(me.id));
    if (!pubB64) pubB64 = await api.getUserPublicKey(me.id);
    if (pubB64)  await cachePublicKey(me.id, pubB64);

    // Save to IndexedDB so refresh works
    _privateKey   = privateKey;
    _publicKeyB64 = pubB64;
    await saveSession(me.id, privateKey, pubB64, me);
    saveLastUserId(me.id);

    setUser(me);
    setKeyReady(true);
    startWS();
    return me;
  }, [startWS]);

  // ── Logout ────────────────────────────────────────────────────────────────
  const signOut = useCallback(async () => {
    clearTimeout(refreshTimer.current);
    wsClient.disconnect();
    const uid = user?.id;
    await api.logout();
    if (uid) await clearSession(uid);
    _privateKey   = null;
    _publicKeyB64 = null;
    setUser(null);
    setKeyReady(false);
    setWsStatus('closed');
  }, [user]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const getRecipientPublicKey = useCallback(async (userId) => {
    const b64 = await api.getUserPublicKey(userId);
    if (!b64) throw new Error('Recipient has no public key registered');
    return importPublicKey(b64);
  }, []);

  const getOwnPublicKey = useCallback(async () => {
    if (!_publicKeyB64) throw new Error('Own public key not loaded');
    return importPublicKey(_publicKeyB64);
  }, []);

  return (
    <AuthContext.Provider value={{
      user,
      get privateKey() { return _privateKey; },
      loading,
      keyReady,
      wsStatus,
      register,
      signIn,
      signOut,
      getRecipientPublicKey,
      getOwnPublicKey,
      isAuthenticated: !!user && keyReady,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
