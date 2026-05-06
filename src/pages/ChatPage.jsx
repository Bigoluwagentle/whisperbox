import { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import Sidebar from '../components/Sidebar';
import MessagePane from '../components/MessagePane';
import NewConversationModal from '../components/NewConversationModal';
import styles from './ChatPage.module.css';

export default function ChatPage() {
  const { user, signOut } = useAuth();
  const [activeConv, setActiveConv] = useState(null); // { id, username, userId }
  const [conversations, setConversations] = useState([]);
  const [showNewConv, setShowNewConv] = useState(false);
  const [refreshConvs, setRefreshConvs] = useState(0);

  const handleNewConversation = (conv) => {
    setShowNewConv(false);
    setConversations(prev => {
      const exists = prev.find(c => c.userId === conv.userId);
      if (!exists) return [conv, ...prev];
      return prev;
    });
    setActiveConv(conv);
  };

  return (
    <div className={styles.root}>
      {/* Sidebar */}
      <Sidebar
        user={user}
        activeConv={activeConv}
        setActiveConv={setActiveConv}
        conversations={conversations}
        setConversations={setConversations}
        onNewConv={() => setShowNewConv(true)}
        onSignOut={signOut}
        refresh={refreshConvs}
      />

      {/* Main pane */}
      <main className={styles.main}>
        {activeConv ? (
          <MessagePane
            conv={activeConv}
            onMessageSent={() => setRefreshConvs(r => r + 1)}
          />
        ) : (
          <EmptyState onNewConv={() => setShowNewConv(true)} />
        )}
      </main>

      {showNewConv && (
        <NewConversationModal
          onClose={() => setShowNewConv(false)}
          onSelect={handleNewConversation}
        />
      )}
    </div>
  );
}

function EmptyState({ onNewConv }) {
  return (
    <div className={styles.empty}>
      <div className={styles.emptyInner}>
        <svg width="56" height="56" viewBox="0 0 56 56" fill="none" style={{marginBottom: 20}}>
          <rect x="8" y="20" width="40" height="28" rx="6" stroke="var(--text-dim)" strokeWidth="1.5"/>
          <path d="M16 20V14a12 12 0 0124 0v6" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round"/>
          <circle cx="28" cy="34" r="4" fill="var(--text-dim)"/>
        </svg>
        <h3 style={{
          fontFamily: 'var(--font-display)',
          fontSize: 18,
          fontWeight: 700,
          color: 'var(--text-secondary)',
          marginBottom: 8
        }}>
          No conversation selected
        </h3>
        <p style={{ color: 'var(--text-dim)', fontSize: 13, marginBottom: 24 }}>
          All messages are end-to-end encrypted
        </p>
        <button
          onClick={onNewConv}
          style={{
            background: 'var(--accent)',
            color: 'var(--bg-0)',
            fontFamily: 'var(--font-display)',
            fontWeight: 700,
            fontSize: 13,
            padding: '10px 20px',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
          }}
        >
          Start conversation
        </button>
      </div>
    </div>
  );
}
