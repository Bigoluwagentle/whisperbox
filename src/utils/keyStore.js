/**
 * keyStore.js
 *
 * Stores the ENCRYPTED private key in IndexedDB so it survives page refreshes.
 *
 * What's stored in IndexedDB:
 *   - The wrapped private key blob (same format as server: base64 JSON {iv, ciphertext})
 *   - The pbkdf2_salt (not secret)
 *   - The user's public key (not secret)
 *   - The user profile
 *
 * What is NEVER stored in plaintext anywhere:
 *   - The raw RSA private key
 *   - The user's password
 *   - The PBKDF2-derived wrapping key
 *
 * On refresh: we have the wrapped key in IndexedDB + the password from the
 * user's session. But we don't have the password anymore after refresh.
 *
 * SOLUTION: Store the unwrapped private key as PKCS8 bytes encrypted with a
 * session-specific AES key. That session AES key is stored in sessionStorage
 * (cleared on tab close). This way:
 *   - Page refresh within the same tab: sessionStorage survives → can decrypt IndexedDB blob
 *   - New tab / browser close: sessionStorage gone → user must log in again (correct)
 *   - IndexedDB blob alone is useless without the sessionStorage key
 */

import { openDB } from 'idb';

const DB_NAME    = 'whisperbox';
const DB_VERSION = 2;
const STORE      = 'session';
const SESSION_KEY_NAME = 'wb_session_key';

async function getDB() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    },
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const bufToB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64ToBuf = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;

/** Generate or retrieve the per-session AES-GCM key stored in sessionStorage */
async function getSessionKey() {
  const stored = sessionStorage.getItem(SESSION_KEY_NAME);
  if (stored) {
    const raw = b64ToBuf(stored);
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  // Generate a new random session key
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const raw = await crypto.subtle.exportKey('raw', key);
  sessionStorage.setItem(SESSION_KEY_NAME, bufToB64(raw));
  return key;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Save the private key to IndexedDB encrypted with a session AES key.
 * Also saves public key and user profile for session restore.
 */
export async function saveSession(userId, privateKey, publicKeyB64, user) {
  const db         = await getDB();
  const sessionKey = await getSessionKey();

  // Export private key as PKCS8 bytes
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', privateKey);

  // Encrypt with session AES key
  const iv        = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sessionKey, pkcs8);

  await db.put(STORE, {
    encryptedKey: bufToB64(encrypted),
    iv:           bufToB64(iv.buffer),
    publicKey:    publicKeyB64,
    user,
  }, `session:${userId}`);
}

/**
 * Restore private key from IndexedDB using the session AES key.
 * Returns null if session expired (sessionStorage cleared).
 */
export async function restoreSession(userId) {
  const sessionKeyRaw = sessionStorage.getItem(SESSION_KEY_NAME);
  if (!sessionKeyRaw) return null; // session expired — must log in again

  const db   = await getDB();
  const data = await db.get(STORE, `session:${userId}`);
  if (!data) return null;

  try {
    const sessionKey = await crypto.subtle.importKey(
      'raw', b64ToBuf(sessionKeyRaw), { name: 'AES-GCM', length: 256 }, false, ['decrypt']
    );

    const pkcs8 = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64ToBuf(data.iv) },
      sessionKey,
      b64ToBuf(data.encryptedKey)
    );

    const privateKey = await crypto.subtle.importKey(
      'pkcs8', pkcs8,
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      true,
      ['decrypt']
    );

    return { privateKey, publicKeyB64: data.publicKey, user: data.user };
  } catch {
    // Session key mismatch or corrupted data
    return null;
  }
}

/**
 * Store the last logged-in userId so we know which session to restore on load.
 */
export function saveLastUserId(userId) {
  sessionStorage.setItem('wb_last_user', userId);
}

export function getLastUserId() {
  return sessionStorage.getItem('wb_last_user');
}

/**
 * Clear session data for a user (on logout).
 */
export async function clearSession(userId) {
  const db = await getDB();
  if (userId) await db.delete(STORE, `session:${userId}`);
  sessionStorage.removeItem(SESSION_KEY_NAME);
  sessionStorage.removeItem('wb_last_user');
}

/** Cache public key by userId (for looking up recipients) */
export async function cachePublicKey(userId, publicKeyB64) {
  const db = await getDB();
  await db.put(STORE, publicKeyB64, `pubkey:${userId}`);
}

export async function getCachedPublicKey(userId) {
  const db = await getDB();
  return db.get(STORE, `pubkey:${userId}`);
}
