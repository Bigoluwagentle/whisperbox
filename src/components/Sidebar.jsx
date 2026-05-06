import { useEffect, useState } from 'react';
import * as api from '../utils/api';
import styles from './Sidebar.module.css';

export default function Sidebar({
  user, activeConv, setActiveConv,
  conversations, setConversations,
  onNewConv, onSignOut, refresh
}) {
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const data = await api.getConversations();
        const list = Array.isArray(data) ? data : (data?.conversations || data?.data || []);
        const mapped = list.map(c => ({
          id:       c.user_id,           
          userId:   c.user_id,           
          username: c.username,
          displayName: c.display_name,
          lastMessageAt: c.last_message_at,
        }));
        setConversations(mapped);
      } catch {}
      setLoading(false);
    };
    load();
  }, [refresh]);

  return (
    <aside className={styles.sidebar}>
      <div className={styles.header}>
        <div className={styles.brand}>
          <LockIcon />
          <span className={styles.brandName}>WhisperBox</span>
        </div>
        <span className="enc-badge" style={{fontSize:9}}>
          <span className="dot"></span>E2EE
        </span>
      </div>

      <div className={styles.actions}>
        <button className={styles.newBtn} onClick={onNewConv}>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          New Message
        </button>
      </div>

      <div className={styles.section}>
        <div className={styles.sectionLabel}>Messages</div>
        <div className={styles.convList}>
          {loading ? (
            <div className={styles.hint}>Loading…</div>
          ) : conversations.length === 0 ? (
            <div className={styles.hint}>No conversations yet</div>
          ) : (
            conversations.map(conv => (
              <ConvItem
                key={conv.id || conv.userId}
                conv={conv}
                active={activeConv?.userId === conv.userId}
                onClick={() => setActiveConv(conv)}
              />
            ))
          )}
        </div>
      </div>

      <div className={styles.footer}>
        <div className={styles.userInfo}>
          <div className={styles.avatar}>{user?.username?.[0]?.toUpperCase() || '?'}</div>
          <div>
            <div className={styles.username}>{user?.username}</div>
            <div className={styles.userSub}>PBKDF2-protected keys</div>
          </div>
        </div>
        <button className={styles.signOut} onClick={onSignOut} title="Sign out">
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
            <path d="M5 7.5h8M10 5l3 2.5-3 2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M8 2H3a1 1 0 00-1 1v9a1 1 0 001 1h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
    </aside>
  );
}

function ConvItem({ conv, active, onClick }) {
  return (
    <button
      className={`${styles.convItem} ${active ? styles.convItemActive : ''}`}
      onClick={onClick}
    >
      <div className={styles.convAvatar}>{conv.username?.[0]?.toUpperCase() || '?'}</div>
      <div className={styles.convMeta}>
        <div className={styles.convName}>{conv.username || 'Unknown'}</div>
        <div className={styles.convLast}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <rect x="1" y="3" width="8" height="6" rx="1.5" stroke="var(--accent)" strokeWidth="0.8"/>
            <path d="M3 3V2a2 2 0 014 0v1" stroke="var(--accent)" strokeWidth="0.8" strokeLinecap="round"/>
          </svg>
          encrypted
        </div>
      </div>
    </button>
  );
}

function LockIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <rect x="2" y="8" width="14" height="9" rx="2" stroke="var(--accent)" strokeWidth="1.2"/>
      <path d="M5 8V5a4 4 0 018 0v3" stroke="var(--accent)" strokeWidth="1.2" strokeLinecap="round"/>
      <circle cx="9" cy="12" r="1.5" fill="var(--accent)"/>
    </svg>
  );
}
