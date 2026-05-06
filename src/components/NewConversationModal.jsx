import { useState, useEffect, useRef } from 'react';
import * as api from '../utils/api';
import styles from './NewConversationModal.module.css';

export default function NewConversationModal({ onClose, onSelect }) {
  const [query, setQuery]     = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const inputRef   = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    if (!query.trim()) { setResults([]); setError(''); return; }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      setError('');
      try {
        // GET /users/search?q=...
        const data = await api.searchUsers(query.trim());
        const list = Array.isArray(data) ? data : (data?.users || data?.results || []);
        setResults(list);
        if (list.length === 0) setError('No users found');
      } catch (e) {
        setError(e.message || 'Search failed');
      } finally {
        setLoading(false);
      }
    }, 350);
  }, [query]);

  const select = (u) => {
    onSelect({
      id:          u.id,
      userId:      u.id,
      username:    u.username,
      displayName: u.display_name,
    });
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h3 className={styles.title}>New Message</h3>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div className={styles.searchWrap}>
          <SearchIcon />
          <input
            ref={inputRef}
            className={styles.searchInput}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by username…"
          />
          {loading && <span className={styles.spinner} />}
        </div>

        <div className={styles.results}>
          {results.length > 0 ? (
            results.map(u => (
              <button key={u.id} className={styles.resultItem} onClick={() => select(u)}>
                <div className={styles.resultAvatar}>{u.username?.[0]?.toUpperCase()}</div>
                <div>
                  <div className={styles.resultName}>{u.display_name || u.username}</div>
                  <div className={styles.resultSub}>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <rect x="1" y="3" width="8" height="6" rx="1.5" stroke="var(--accent)" strokeWidth="0.8"/>
                      <path d="M3 3V2a2 2 0 014 0v1" stroke="var(--accent)" strokeWidth="0.8" strokeLinecap="round"/>
                    </svg>
                    @{u.username} · public key registered
                  </div>
                </div>
              </button>
            ))
          ) : query && !loading ? (
            <div className={styles.empty}>{error || 'No users found'}</div>
          ) : !query ? (
            <div className={styles.empty}>Type a username to search</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{flexShrink:0}}>
      <circle cx="6" cy="6" r="4.5" stroke="var(--text-dim)" strokeWidth="1.2"/>
      <path d="M9.5 9.5l2.5 2.5" stroke="var(--text-dim)" strokeWidth="1.2" strokeLinecap="round"/>
    </svg>
  );
}
