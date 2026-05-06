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

let _privateKey   = null;
let _publicKeyB64 = null;

export function AuthProvider({ children }) {
  const [user,     setUser]     = useState(null);
  const [keyReady, setKeyReady] = useState(false);
  const [loading,  setLoading]  = useState(true);
  const [wsStatus, setWsStatus] = useState('closed');
  const refreshTimer = useRef(null);

  const startWS = useCallback(() => {
    wsClient.onStatusChange = setWsStatus;
    wsClient.connect();

    clearTimeout(refreshTimer.current);
    const tick = async () => {
      try { await api.refreshToken(); } catch (_) {}
      refreshTimer.current = setTimeout(tick, 12 * 60 * 1000);
    };
    refreshTimer.current = setTimeout(tick, 12 * 60 * 1000);
  }, []);

  useEffect(() => {
    const restore = async () => {
      try {
        const userId = getLastUserId();
        if (!userId) { setLoading(false); return; }

        const session = await restoreSession(userId);
        if (!session) {
          setLoading(false);
          return;
        }

        const hasAccess = !!api.tokenStore.getAccess();
        if (!hasAccess) {
          try { await api.refreshToken(); }
          catch (_) { setLoading(false); return; }
        }

        const me = await api.getMe();

        _privateKey   = session.privateKey;
        _publicKeyB64 = session.publicKeyB64;

        setUser(me);
        setKeyReady(true);
        startWS();
      } catch (e) {
        api.tokenStore.clear();
      } finally {
        setLoading(false);
      }
    };
    restore();
    return () => clearTimeout(refreshTimer.current);
  }, [startWS]);

  const register = useCallback(async (username, password) => {
    const keyPair      = await generateKeyPair();
    const publicKeyB64 = await exportPublicKey(keyPair.publicKey);
    const pbkdf2Salt      = generateSalt();
    const wrappingKey     = await deriveWrappingKey(password, pbkdf2Salt);
    const wrappedPrivKey  = await wrapPrivateKey(keyPair.privateKey, wrappingKey);

    const data = await api.register({
      username,
      password,
      publicKey:         publicKeyB64,
      wrappedPrivateKey: wrappedPrivKey,
      pbkdf2Salt,
    });

    const me = data.user;
    if (!me) throw new Error('Register response missing user object');

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

  const signIn = useCallback(async (username, password) => {
    
    const data = await api.login(username, password);
    const me   = data.user;
    if (!me) throw new Error('Login response missing user object');

    const wrappedPrivateKey = me.wrapped_private_key;
    const pbkdf2Salt        = me.pbkdf2_salt;
    const publicKeyB64      = me.public_key;

    if (!wrappedPrivateKey || !pbkdf2Salt) {
      throw new Error('Server did not return key material.');
    }

    const wrappingKey = await deriveWrappingKey(password, pbkdf2Salt);
    const privateKey  = await unwrapPrivateKey(wrappedPrivateKey, wrappingKey);

    let pubB64 = publicKeyB64 || (await getCachedPublicKey(me.id));
    if (!pubB64) pubB64 = await api.getUserPublicKey(me.id);
    if (pubB64)  await cachePublicKey(me.id, pubB64);

    _privateKey   = privateKey;
    _publicKeyB64 = pubB64;
    await saveSession(me.id, privateKey, pubB64, me);
    saveLastUserId(me.id);

    setUser(me);
    setKeyReady(true);
    startWS();
    return me;
  }, [startWS]);

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
