/**
 * MessagePane.jsx
 *
 * - Primary delivery: WebSocket (message.send frame)
 * - Fallback: REST POST /messages
 * - History: GET /conversations/{userId}/messages (paginated, newest-first → reversed)
 * - Real-time: listens to wsClient.onMessage for message.receive frames
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import * as api from '../utils/api';
import { wsClient } from '../utils/wsClient';
import {
  encryptMessage,
  decryptReceivedMessage,
  decryptSentMessage,
} from '../utils/crypto';
import { format } from 'date-fns';
import styles from './MessagePane.module.css';

export default function MessagePane({ conv, onMessageSent }) {
  const { user, privateKey, getRecipientPublicKey, getOwnPublicKey, wsStatus } = useAuth();
  const [messages, setMessages]   = useState([]);
  const [input, setInput]         = useState('');
  const [sending, setSending]     = useState(false);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [hasMore, setHasMore]     = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const bottomRef = useRef(null);
  const oldestCursor = useRef(null);

  // ── Decrypt a single message from GET /conversations/{userId}/messages ──────
  // Message shape: { id, from_user_id, to_user_id, payload: { ciphertext, iv,
  //                  encryptedKey, encryptedKeyForSelf }, delivered, created_at }
  const decryptMsg = useCallback(async (m) => {
    try {
      const myId  = user?.id;
      const isMine = m.from_user_id === myId;
      let plaintext;

      if (isMine) {
        // Sender reads their own message using encryptedKeyForSelf
        plaintext = await decryptSentMessage(
          {
            ciphertext:          m.payload.ciphertext,
            iv:                  m.payload.iv,
            encryptedKeyForSelf: m.payload.encryptedKeyForSelf,
          },
          privateKey
        );
      } else {
        // Recipient decrypts using encryptedKey
        plaintext = await decryptReceivedMessage(
          {
            ciphertext:   m.payload.ciphertext,
            iv:           m.payload.iv,
            encryptedKey: m.payload.encryptedKey,
          },
          privateKey
        );
      }
      return { ...m, plaintext, decrypted: true, isMine };
    } catch (e) {
      const isMine = m.from_user_id === user?.id;
      return { ...m, plaintext: null, decrypted: false, isMine };
    }
  }, [privateKey, user]);

  // ── Load history ──────────────────────────────────────────────────────────
  // GET /conversations/{userId}/messages → array, newest-first
  // Pagination: ?before=<ISO-8601 timestamp>
  const loadHistory = useCallback(async () => {
    if (!conv || !privateKey) return;
    setLoading(true);
    try {
      const msgs = await api.getMessages(conv.userId);
      const arr  = Array.isArray(msgs) ? msgs : [];

      // API returns newest-first — reverse so oldest is at top
      const chronological = [...arr].reverse();

      // Store oldest timestamp for "load more" cursor
      if (chronological.length > 0) {
        oldestCursor.current = chronological[0].created_at;
      }

      // If we got a full page (50 default) there may be more
      setHasMore(arr.length >= 50);

      const decrypted = await Promise.all(chronological.map(decryptMsg));
      setMessages(decrypted);
    } catch (e) {
      setError('Failed to load messages: ' + e.message);
    } finally {
      setLoading(false);
    }
  }, [conv, privateKey, decryptMsg]);

  // ── Load older messages (pagination) ─────────────────────────────────────
  const loadMore = async () => {
    if (!hasMore || loadingMore || !oldestCursor.current) return;
    setLoadingMore(true);
    try {
      // ?before=<ISO-8601> returns messages older than that timestamp
      const msgs = await api.getMessages(conv.userId, oldestCursor.current);
      const arr  = Array.isArray(msgs) ? msgs : [];
      if (arr.length === 0) { setHasMore(false); return; }

      const chronological = [...arr].reverse();
      oldestCursor.current = chronological[0].created_at; // oldest in this page
      setHasMore(arr.length >= 50);

      const decrypted = await Promise.all(chronological.map(decryptMsg));
      setMessages(prev => [...decrypted, ...prev]);
    } catch (e) {
      setError('Failed to load more: ' + e.message);
    } finally {
      setLoadingMore(false);
    }
  };

  // ── Handle real-time incoming WS message.receive frame ───────────────────
  // Frame shape: { event: "message.receive", id, from_user_id, to_user_id,
  //                payload: { ciphertext, iv, encryptedKey, encryptedKeyForSelf },
  //                created_at }
  const handleIncoming = useCallback(async (frame) => {
    // Only handle messages from the currently open conversation
    if (frame.from_user_id !== conv.userId) return;

    // Build a message object matching the REST history shape for decryptMsg
    const msg = {
      id:          frame.id,
      from_user_id: frame.from_user_id,
      to_user_id:  frame.to_user_id,
      payload:     frame.payload,
      created_at:  frame.created_at,
    };

    const decrypted = await decryptMsg(msg);
    setMessages(prev => {
      // Deduplicate by id
      if (prev.find(m => m.id === decrypted.id)) return prev;
      return [...prev, decrypted];
    });
  }, [conv.userId, decryptMsg]);

  useEffect(() => {
    setMessages([]);
    oldestCursor.current = null;
    setHasMore(false);
    loadHistory();
  }, [loadHistory]);

  // Register WS listener for this conversation
  useEffect(() => {
    // wsClient.onMessage passes the full message.receive frame
    const unsub = wsClient.onMessage(handleIncoming);
    return unsub;
  }, [handleIncoming]);

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── Send ──────────────────────────────────────────────────────────────────
  const sendMsg = async () => {
    if (!input.trim() || sending) return;
    setError('');
    setSending(true);
    const text = input.trim();
    setInput('');
    try {
      // 1. Fetch recipient's RSA public key and encrypt the message
      const recipientPub = await getRecipientPublicKey(conv.userId);
      const ownPub       = await getOwnPublicKey();
      const payload      = await encryptMessage(text, recipientPub, ownPub);

      // 2. Try WebSocket first (primary), fall back to REST POST /messages
      const sentViaWS = wsClient.sendMessage(conv.userId, payload);
      if (!sentViaWS) {
        await api.sendMessageREST(conv.userId, payload);
      }

      // 3. Optimistically add sent message — shape matches decryptMsg expectation
      const optimistic = {
        id:           `opt-${Date.now()}`,
        from_user_id: user?.id,
        to_user_id:   conv.userId,
        payload:      {
          ciphertext:          payload.ciphertext,
          iv:                  payload.iv,
          encryptedKey:        payload.encryptedKey,
          encryptedKeyForSelf: payload.encryptedKeyForSelf,
        },
        created_at:   new Date().toISOString(),
        plaintext:    text,   // already known — skip re-decryption
        decrypted:    true,
        isMine:       true,
      };
      setMessages(prev => [...prev, optimistic]);
      onMessageSent?.();
    } catch (e) {
      setError(e.message || 'Failed to send');
      setInput(text); // restore on failure
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
  };

  const wsIndicator = {
    open:       { color: 'var(--accent)',   label: 'live' },
    connecting: { color: 'var(--warning)',  label: 'connecting…' },
    closed:     { color: 'var(--text-dim)', label: 'offline' },
  }[wsStatus] || { color: 'var(--text-dim)', label: wsStatus };

  return (
    <div className={styles.root}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.avatar}>{conv.username?.[0]?.toUpperCase()}</div>
          <div>
            <div className={styles.username}>{conv.username}</div>
            <div className={styles.subline}>
              <LockMiniIcon /> end-to-end encrypted
              <span style={{color: wsIndicator.color, marginLeft: 8}}>
                ● {wsIndicator.label}
              </span>
            </div>
          </div>
        </div>
        <span className="enc-badge"><span className="dot"></span>AES-256-GCM · RSA-OAEP</span>
      </div>

      {/* Load more */}
      {hasMore && (
        <div className={styles.loadMoreBar}>
          <button className={styles.loadMoreBtn} onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load older messages'}
          </button>
        </div>
      )}

      {/* Messages */}
      <div className={styles.messages}>
        {loading ? (
          <div className={styles.loadingState}>
            <div className={styles.spinner} />
            <span>Decrypting messages…</span>
          </div>
        ) : messages.length === 0 ? (
          <div className={styles.emptyState}>
            <span className="enc-badge"><span className="dot"></span>Encrypted channel open</span>
            <p style={{marginTop: 10, color: 'var(--text-dim)', fontSize: 13}}>
              Send your first encrypted message
            </p>
          </div>
        ) : (
          messages.map((m, i) => <MessageBubble key={m.id || m._id || i} msg={m} />)
        )}
        <div ref={bottomRef} />
      </div>

      {/* Error bar */}
      {error && (
        <div className={styles.errorBar}>
          ⚠ {error}
          <button onClick={() => setError('')} style={{marginLeft:8,color:'inherit'}}>✕</button>
        </div>
      )}

      {/* Input */}
      <div className={styles.inputArea}>
        <div className={styles.inputWrap}>
          <div className={styles.lockIcon}><LockMiniIcon /></div>
          <textarea
            className={styles.input}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a message… (encrypted before sending)"
            rows={1}
            disabled={sending}
          />
          <button className={styles.sendBtn} onClick={sendMsg} disabled={sending || !input.trim()}>
            {sending ? <span className={styles.spinner} /> : <SendIcon />}
          </button>
        </div>
        <div className={styles.hint}>
          Encrypted with AES-256-GCM · Key exchanged via RSA-OAEP · Enter to send
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ msg }) {
  const { isMine, plaintext, decrypted, created_at } = msg;
  return (
    <div className={`${styles.bubble} ${isMine ? styles.mine : styles.theirs}`}>
      <div className={styles.bubbleInner}>
        {decrypted ? (
          <p className={styles.text}>{plaintext}</p>
        ) : (
          <p className={styles.decryptErr}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="6" cy="6" r="5" stroke="var(--danger)" strokeWidth="1"/>
              <path d="M6 4v3M6 8.5v.5" stroke="var(--danger)" strokeWidth="1" strokeLinecap="round"/>
            </svg>
            Decryption failed
          </p>
        )}
        <div className={styles.meta}>
          {created_at && (
            <span>{format(new Date(created_at), 'HH:mm')}</span>
          )}
          {decrypted && (
            <span className={styles.encTag}>
              <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                <rect x="1" y="3" width="6" height="4" rx="1" stroke="currentColor" strokeWidth="0.8"/>
                <path d="M2.5 3V2a1.5 1.5 0 013 0v1" stroke="currentColor" strokeWidth="0.8" strokeLinecap="round"/>
              </svg>
              e2e
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function LockMiniIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
      <rect x="1" y="4.5" width="9" height="6" rx="1.5" stroke="var(--accent)" strokeWidth="0.9"/>
      <path d="M3 4.5V3a2.5 2.5 0 015 0v1.5" stroke="var(--accent)" strokeWidth="0.9" strokeLinecap="round"/>
      <circle cx="5.5" cy="7.5" r="1" fill="var(--accent)"/>
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M2 8h12M10 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
