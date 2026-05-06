/**
 * api.js — WhisperBox API Client
 * Base URL: https://whisperbox.koyeb.app
 *
 * All field names match the documented API exactly.
 * Access tokens expire in 15 min — auto-refresh on 401.
 */

const BASE = 'https://whisperbox.koyeb.app';

// ── Token storage ─────────────────────────────────────────────────────────────
// Access token  → sessionStorage (short-lived, cleared on tab close — good)
// Refresh token → localStorage   (must survive tab close so sign-in works across sessions)
// Neither token is crypto key material so this is safe.
export const tokenStore = {
  getAccess:  () => sessionStorage.getItem('wb_access'),
  getRefresh: () => localStorage.getItem('wb_refresh'),
  setTokens:  (access, refresh) => {
    if (access)  sessionStorage.setItem('wb_access',  access);
    if (refresh) localStorage.setItem('wb_refresh',   refresh);
  },
  clear: () => {
    sessionStorage.removeItem('wb_access');
    localStorage.removeItem('wb_refresh');
  },
};

// ── Auto-refresh on 401 ───────────────────────────────────────────────────────
let _refreshPromise = null;

async function doRefresh() {
  const refresh = tokenStore.getRefresh();
  if (!refresh) throw new Error('No refresh token');

  const res = await fetch(`${BASE}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refresh }),
  });

  if (!res.ok) {
    tokenStore.clear();
    // Navigate to login — the WS close handler also catches 4001
    window.location.replace('/auth');
    throw new Error('Session expired — please log in again');
  }

  const data = await res.json();
  // /auth/refresh only returns a new access_token (no new refresh token per spec)
  tokenStore.setTokens(data.access_token, null);
  return data.access_token;
}

// ── Core request helper ───────────────────────────────────────────────────────
async function request(path, options = {}, _retry = true) {
  const token = tokenStore.getAccess();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  };

  const res = await fetch(`${BASE}${path}`, { ...options, headers });

  if (res.status === 401 && _retry) {
    // Deduplicate concurrent refresh calls
    if (!_refreshPromise) {
      _refreshPromise = doRefresh().finally(() => { _refreshPromise = null; });
    }
    await _refreshPromise;
    return request(path, options, false); // one retry
  }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      msg = body.detail || body.message || body.error || msg;
    } catch (_) {}
    throw new Error(msg);
  }

  if (res.status === 204) return null;
  return res.json();
}

// ── Auth ──────────────────────────────────────────────────────────────────────

/**
 * POST /auth/register
 * Sends all key material — server stores blobs verbatim, never inspects them.
 *
 * Request body (exact field names from API spec):
 *   username, display_name, password,
 *   public_key, wrapped_private_key, pbkdf2_salt
 *
 * Response: { access_token, refresh_token, token_type, expires_in, user }
 */
export async function register({ username, password, publicKey, wrappedPrivateKey, pbkdf2Salt }) {
  const data = await request('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      username,
      display_name: username,       // use username as display name by default
      password,
      public_key:          publicKey,
      wrapped_private_key: wrappedPrivateKey,
      pbkdf2_salt:         pbkdf2Salt,
    }),
  });
  tokenStore.setTokens(data.access_token, data.refresh_token);
  return data;
}

/**
 * POST /auth/login
 * Response includes wrapped_private_key + pbkdf2_salt for client-side unwrapping.
 * Also includes the full user profile with public_key.
 */
export async function login(username, password) {
  const data = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  tokenStore.setTokens(data.access_token, data.refresh_token);
  return data;
}

/**
 * GET /auth/me
 * Returns the current user profile including key material.
 * Use this after login to get wrapped_private_key and pbkdf2_salt.
 */
export async function getMe() {
  return request('/auth/me');
}

/**
 * POST /auth/refresh
 * Called proactively every 12 min and also on 401 responses.
 */
export async function refreshToken() {
  return doRefresh();
}

/**
 * POST /auth/logout
 * Revokes the refresh token. Access token expires naturally after 15 min.
 */
export async function logout() {
  const refresh = tokenStore.getRefresh();
  try {
    if (refresh) {
      await request('/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: refresh }),
      });
    }
  } catch (_) { /* best-effort */ }
  tokenStore.clear();
}

// ── Users ─────────────────────────────────────────────────────────────────────

/**
 * GET /users/search?q=<query>
 * Returns up to 20 users. Current user excluded from results.
 * Response: [{ id, username, display_name }]
 */
export async function searchUsers(q) {
  return request(`/users/search?q=${encodeURIComponent(q)}`);
}

/**
 * GET /users/{userId}/public-key
 * Response: { public_key: "<base64 SPKI>" }
 */
export async function getUserPublicKey(userId) {
  const data = await request(`/users/${userId}/public-key`);
  return data?.public_key;
}

// ── Conversations & Messages ──────────────────────────────────────────────────

/**
 * GET /conversations
 * Returns list sorted by most recent message.
 * Response: [{ user_id, display_name, username, last_message_at }]
 */
export async function getConversations() {
  return request('/conversations');
}

/**
 * GET /conversations/{userId}/messages
 * Returns messages newest-first. Use 'before' (ISO-8601 timestamp) for pagination.
 *
 * Response: [{
 *   id, from_user_id, to_user_id,
 *   payload: { ciphertext, iv, encryptedKey, encryptedKeyForSelf },
 *   delivered, created_at
 * }]
 */
export async function getMessages(userId, before = null) {
  const qs = before ? `?before=${encodeURIComponent(before)}` : '';
  return request(`/conversations/${userId}/messages${qs}`);
}

/**
 * POST /messages — offline fallback only (prefer WebSocket)
 *
 * Request body (exact field names from API spec):
 * {
 *   to: "<recipient UUID>",
 *   payload: { ciphertext, iv, encryptedKey, encryptedKeyForSelf }
 * }
 */
export async function sendMessageREST(recipientId, payload) {
  return request('/messages', {
    method: 'POST',
    body: JSON.stringify({
      to: recipientId,              // API spec uses "to", not "recipient_id"
      payload: {
        ciphertext:          payload.ciphertext,
        iv:                  payload.iv,
        encryptedKey:        payload.encryptedKey,
        encryptedKeyForSelf: payload.encryptedKeyForSelf,
      },
    }),
  });
}
