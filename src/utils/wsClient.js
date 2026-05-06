/**
 * wsClient.js — WhisperBox WebSocket Manager
 *
 * Endpoint: wss://whisperbox.koyeb.app/ws?token=<access_token>
 *
 * Client → Server frame:
 *   { event: "message.send", to: "<uuid>", payload: { ciphertext, iv, encryptedKey, encryptedKeyForSelf } }
 *
 * Server → Client frames:
 *   { event: "message.receive", id, from_user_id, to_user_id, payload, created_at }
 *   { event: "user.online",  user_id }
 *   { event: "user.offline", user_id }
 *   { event: "error",        detail }
 *
 * Close codes (server always completes WS handshake before closing):
 *   4001 — access token expired  → refresh token then reconnect
 *   4003 — token missing/invalid → redirect to login
 */

import { tokenStore, refreshToken } from './api';

const WS_URL = 'wss://whisperbox.koyeb.app/ws';

class WSClient {
  constructor() {
    this.ws             = null;
    this._msgListeners  = new Set();   // (payload) => void  for message.receive
    this._presListeners = new Set();   // ({ event, user_id }) => void
    this.onStatusChange = null;        // (status) => void
    this._reconnTimer   = null;
    this._reconnDelay   = 2_000;
    this._stopped       = false;
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Connect (or reconnect) using current access token */
  connect() {
    this._stopped = false;
    const token   = tokenStore.getAccess();
    if (!token) { this._setStatus('closed'); return; }

    this._setStatus('connecting');
    const ws = new WebSocket(`${WS_URL}?token=${encodeURIComponent(token)}`);
    this.ws  = ws;

    ws.onopen = () => {
      this._reconnDelay = 2_000;   // reset backoff on successful connect
      this._setStatus('open');
    };

    ws.onmessage = (evt) => {
      let frame;
      try { frame = JSON.parse(evt.data); } catch { return; }

      switch (frame.event) {
        case 'message.receive':
          this._msgListeners.forEach(fn => fn(frame));
          break;
        case 'user.online':
        case 'user.offline':
          this._presListeners.forEach(fn => fn(frame));
          break;
        case 'error':
          console.warn('[WS] server error frame:', frame.detail);
          break;
        default:
          break;
      }
    };

    ws.onclose = async (evt) => {
      this._setStatus('closed');
      this.ws = null;

      if (this._stopped) return;

      if (evt.code === 4001) {
        // Access token expired — refresh then reconnect
        try {
          await refreshToken();
          this._scheduleReconnect(300);
        } catch (_) {
          // refresh failed → doRefresh already redirected to /auth
        }
        return;
      }

      if (evt.code === 4003) {
        // Invalid token — redirect to login
        tokenStore.clear();
        window.location.replace('/auth');
        return;
      }

      // Any other close (network drop, server restart) — reconnect with backoff
      this._scheduleReconnect(this._reconnDelay);
      this._reconnDelay = Math.min(this._reconnDelay * 1.5, 30_000);
    };

    ws.onerror = () => {
      // onerror always followed by onclose — let onclose handle it
      ws.close();
    };
  }

  /** Stop the WebSocket and prevent auto-reconnect */
  disconnect() {
    this._stopped = true;
    clearTimeout(this._reconnTimer);
    if (this.ws) {
      this.ws.onclose = null; // prevent reconnect loop on intentional close
      this.ws.close();
      this.ws = null;
    }
    this._setStatus('closed');
  }

  /**
   * Send a message.send frame.
   * @returns {boolean} true if sent via WebSocket, false if WS not open (use REST fallback)
   */
  sendMessage(recipientId, payload) {
    if (!this.isOpen) return false;
    this.ws.send(JSON.stringify({
      event: 'message.send',      // API spec uses "event", not "type"
      to:    recipientId,          // API spec uses "to", not "recipient_id"
      payload: {
        ciphertext:          payload.ciphertext,
        iv:                  payload.iv,
        encryptedKey:        payload.encryptedKey,
        encryptedKeyForSelf: payload.encryptedKeyForSelf,
      },
    }));
    return true;
  }

  /** Register a listener for incoming message.receive frames */
  onMessage(handler) {
    this._msgListeners.add(handler);
    return () => this._msgListeners.delete(handler);
  }

  /** Register a listener for presence events (user.online / user.offline) */
  onPresence(handler) {
    this._presListeners.add(handler);
    return () => this._presListeners.delete(handler);
  }

  _scheduleReconnect(delay) {
    clearTimeout(this._reconnTimer);
    this._reconnTimer = setTimeout(() => this.connect(), delay);
  }

  _setStatus(status) {
    this.onStatusChange?.(status);
  }
}

// Singleton — one WS connection per app session
export const wsClient = new WSClient();
