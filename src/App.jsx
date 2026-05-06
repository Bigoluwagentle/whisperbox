import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import AuthPage from './pages/AuthPage';
import ChatPage from './pages/ChatPage';
import MissingKeyPage from './pages/MissingKeyPage';

function ProtectedRoute({ children }) {
  const { user, loading, keyReady } = useAuth();
  if (loading) return <FullscreenLoader />;
  if (!user) return <Navigate to="/auth" replace />;
  if (!keyReady) return <Navigate to="/missing-key" replace />;
  return children;
}

function FullscreenLoader() {
  return (
    <div style={{
      height: '100vh', display: 'flex', alignItems: 'center',
      justifyContent: 'center', flexDirection: 'column', gap: 16,
      background: 'var(--bg-0)'
    }}>
      <div style={{
        width: 32, height: 32,
        border: '2px solid var(--bg-3)',
        borderTop: '2px solid var(--accent)',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite'
      }} />
      <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>initializing…</span>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route path="/auth" element={<AuthPage />} />
          <Route path="/missing-key" element={<MissingKeyPage />} />
          <Route path="/*" element={
            <ProtectedRoute><ChatPage /></ProtectedRoute>
          } />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
