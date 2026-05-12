# WhisperBox — End-to-End Encrypted Messaging

> HNG14 Stage 4B · Frontend Wizards

Live demo: _https://your-deployment-url.vercel.app_
GitHub: _https://github.com/your-username/whisperbox_

---

## Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          CLIENT (Browser)                                │
│                                                                          │
│  ┌─────────────┐    ┌───────────────────┐    ┌───────────────────────┐  │
│  │  React UI   │───▶│   AuthContext     │───▶│   Web Crypto API      │  │
│  │  (Vite)     │    │  JWT + key mgmt   │    │   RSA-OAEP / AES-GCM  │  │
│  └─────────────┘    └───────────────────┘    │   AES-KW / PBKDF2     │  │
│         │                    │               └───────────────────────┘  │
│         │           ┌────────▼────────┐                                 │
│         │           │  In-Memory Only │  ← Private key NEVER persisted  │
│         │           │  CryptoKey ref  │    in plaintext anywhere         │
│         │           └─────────────────┘                                 │
│         │                                                                │
│         ▼  WebSocket (primary) + REST fallback                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                    wsClient.js / api.js                          │   │
│  │  WS:   { type: 'message.send', payload: { ciphertext, iv,... } } │   │
│  │  REST: POST /messages → { payload: { ciphertext, iv, ... } }     │   │
│  │                 ← backend only ever sees ciphertext →            │   │
│  └──────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ HTTPS / WSS only
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│              Backend — whisperbox.koyeb.app                              │
│                                                                          │
│  ┌────────────┐  ┌──────────────────────────┐  ┌─────────────────────┐  │
│  │ Auth / JWT │  │     User store           │  │   Message store     │  │
│  │ 15-min AT  │  │  public_key (SPKI b64)   │  │  ciphertext blobs   │  │
│  │ refresh RT │  │  wrapped_private_key     │  │  iv, encryptedKey   │  │
│  └────────────┘  │  pbkdf2_salt             │  │  encryptedKeyForSelf│  │
│                  └──────────────────────────┘  └─────────────────────┘  │
│                                                                          │
│  ✗ Server NEVER sees plaintext messages                                  │
│  ✗ Server NEVER sees the raw private key (only the AES-KW wrapped form)  │
│  ✗ Server NEVER sees the PBKDF2 password                                 │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Encryption Flow

### Registration

```
CLIENT                                              SERVER
  │                                                    │
  ├─ generateKeyPair()                                  │
  │    RSA-OAEP 2048-bit { publicKey, privateKey }      │
  │                                                    │
  ├─ generateSalt()         → random 16-byte base64    │
  ├─ deriveWrappingKey(password, salt)                 │
  │    PBKDF2-SHA-256, 310,000 iterations              │
  │    → AES-256-KW wrapping key (never leaves device) │
  │                                                    │
  ├─ wrapPrivateKey(privateKey, wrappingKey)           │
  │    AES-KW wrap → wrappedPrivateKey (base64)        │
  │                                                    │
  ├── POST /auth/register ─────────────────────────────▶
  │   { username, password, public_key,                │
  │     wrapped_private_key, pbkdf2_salt }             │
  │                                                    ├─ store public_key
  │                                                    ├─ store wrapped_private_key
  │                                              ◀─────┤ pbkdf2_salt (safe — no key material)
  │   { access_token, refresh_token, user }            │
  │                                                    │
  └─ privateKey kept IN MEMORY ONLY (never stored)     │
```

### Login (any device)

```
CLIENT                                              SERVER
  │                                                    │
  ├── POST /auth/login ────────────────────────────────▶
  │   { username, password }                           │
  │                                              ◀─────┤
  │   { access_token, refresh_token,                   │
  │     wrapped_private_key, pbkdf2_salt, user }       │
  │                                                    │
  ├─ deriveWrappingKey(password, pbkdf2_salt)          │
  │    PBKDF2-SHA-256, 310,000 iterations              │
  │    → wrappingKey (ephemeral, in memory only)       │
  │                                                    │
  ├─ unwrapPrivateKey(wrapped_private_key, wrappingKey)│
  │    AES-KW unwrap → privateKey (CryptoKey, memory)  │
  │                                                    │
  └─ WebSocket opened: wss://.../ws?token=<AT>         │
```

### Sending a Message

```
1.  GET /users/{recipientId}/public-key → base64 SPKI
2.  importPublicKey(base64)             → recipient CryptoKey
3.  generateAESKey()                    → ephemeral AES-256-GCM key
4.  encryptWithAES(aesKey, plaintext)   → { iv (96-bit random), ciphertext }
5.  wrapAESKeyWithRSA(aesKey, recipientPub) → encryptedKey
6.  wrapAESKeyWithRSA(aesKey, ownPub)       → encryptedKeyForSelf

7a. WS frame (primary):
    { type: 'message.send', payload: {
        recipient_id, ciphertext, iv,
        encryptedKey, encryptedKeyForSelf } }

7b. REST fallback (if WS unavailable):
    POST /messages → { recipient_id, payload: { ... } }

✗ Server stores ciphertext, iv, encryptedKey, encryptedKeyForSelf
✗ Server never sees the AES key or the plaintext
```

### Receiving a Message

```
Real-time: WS frame { type: 'message.receive', payload: { ... } }
History:   GET /conversations/{userId}/messages?before=<cursor>

Decryption (received):
  unwrapAESKeyWithRSA(encryptedKey, myPrivateKey) → aesKey
  decryptWithAES(aesKey, iv, ciphertext)          → plaintext ✓

Decryption (own sent messages):
  unwrapAESKeyWithRSA(encryptedKeyForSelf, myPrivateKey) → aesKey
  decryptWithAES(aesKey, iv, ciphertext)                 → plaintext ✓

Failure: shown as "Decryption failed" in UI — no crash, no data leak
```

---

## Key Management

| Key | Where stored | Ever transmitted? |
|-----|-------------|-------------------|
| RSA Public Key (2048-bit SPKI) | Server DB | ✅ Yes — public by design |
| RSA Private Key (raw) | **Never stored anywhere** | ❌ Never |
| RSA Private Key (AES-KW wrapped) | Server DB | ✅ Yes — opaque blob, useless without password |
| PBKDF2 password | Never stored | ❌ Never transmitted |
| PBKDF2 salt | Server DB | ✅ Yes — not secret |
| AES-KW wrapping key | In memory only (ephemeral) | ❌ Never |
| Ephemeral AES-256-GCM session key | In memory only | ❌ Never (only its RSA-wrapped form) |
| JWT access token | sessionStorage | ✅ Yes — sent as Bearer header |
| JWT refresh token | sessionStorage | ✅ Yes — used to get new access tokens |

### Cross-Device Login
Unlike a naive IndexedDB-only design, this app supports any device login because the server stores the PBKDF2-wrapped private key. Only the correct password can unwrap it — the server never learns the password.

---

## Security Trade-offs

### Protections
- **Server breach**: Attacker gets ciphertext + wrapped private keys. Without users' passwords (not stored on server), messages cannot be decrypted.
- **Network interception**: All transport is WSS/HTTPS + per-message AES-GCM encryption. Replay is prevented by random 96-bit IVs and message IDs.
- **Offline message delivery**: WS connect triggers server flush of queued messages.

### Known Limitations

1. **No forward secrecy**: Long-lived RSA keys mean compromising one key exposes all past messages. A Signal Protocol / Double Ratchet upgrade would fix this.

2. **Password is the root secret**: If a user's password is weak or compromised, an attacker with the server DB can brute-force the PBKDF2 wrapping (mitigated by 310,000 iterations).

3. **No message authentication signatures**: AES-GCM provides integrity (tamper detection) but the server could theoretically substitute an encrypted message. Adding RSA signatures over the ciphertext would close this.

4. **Optimistic UI**: Sent messages appear instantly. If the server rejects them, an error is shown but the optimistic bubble stays. A production app would reconcile on the next history fetch.

5. **No group messaging**: Architecture is 1:1 only.

6. **Session token in sessionStorage**: If a malicious script runs in the page (XSS), it could read the JWT. Mitigated by keeping crypto keys only in `CryptoKey` objects (not extractable to sessionStorage).

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| UI Framework | React 18 + Vite |
| Routing | React Router v6 |
| Encryption | Web Crypto API (browser-native) |
| Key storage | In-memory (CryptoKey) + server (AES-KW wrapped) |
| Public key cache | IndexedDB (not sensitive) |
| Realtime | WebSocket (`wss://whisperbox.koyeb.app/ws`) |
| Session | sessionStorage (JWT only — no key material) |
| Styling | CSS Modules |
| Date formatting | date-fns |

---

## Local Development

```bash
git clone https://github.com/bigoluwagentle/whisperbox.git
cd whisperbox
npm install
npm run dev       # http://localhost:5173 https://whisperbox-five.vercel.app/
```

> Web Crypto API requires a **secure context** (`https://` or `localhost`). Works out of the box in dev.

## Build & Deploy

```bash
npm run build     # → dist/
```

Deploy `dist/` to Vercel / Netlify / any static CDN. Must be served over HTTPS.

---

## Folder Structure

```
whisperbox/
├── index.html
├── vite.config.js
├── package.json
├── .gitignore
├── README.md
└── src/
    ├── main.jsx
    ├── App.jsx                         ← Router + ProtectedRoute
    ├── index.css                       ← Design tokens (CSS variables)
    ├── utils/
    │   ├── crypto.js                   ⭐ ALL Web Crypto API logic
    │   ├── keyStore.js                 ⭐ In-memory key + IndexedDB pub key cache
    │   ├── wsClient.js                 ⭐ WebSocket manager (singleton)
    │   └── api.js                      ← REST API client + auto token refresh
    ├── contexts/
    │   └── AuthContext.jsx             ⭐ Auth + key lifecycle + WS connect
    ├── pages/
    │   ├── AuthPage.jsx / .module.css
    │   ├── ChatPage.jsx / .module.css
    │   └── MissingKeyPage.jsx
    └── components/
        ├── Sidebar.jsx / .module.css
        ├── MessagePane.jsx / .module.css   ⭐ WS primary + REST fallback + pagination
        └── NewConversationModal.jsx / .module.css
```

---

## API Endpoints Used

Base: `https://whisperbox.koyeb.app`

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/auth/register` | Register with public key + wrapped private key + salt |
| POST | `/auth/login` | Login → get wrapped private key + salt to unwrap locally |
| POST | `/auth/refresh` | Refresh access token (auto, every 12 min) |
| POST | `/auth/logout` | Revoke refresh token |
| GET | `/users/me` | Get own profile |
| GET | `/users/search?q=` | Search users |
| GET | `/users/{userId}/public-key` | Get a user's RSA public key |
| GET | `/conversations` | List all conversation threads |
| GET | `/conversations/{userId}/messages` | Paginated message history |
| POST | `/messages` | REST fallback for sending (when WS unavailable) |
| WSS | `/ws?token=<AT>` | Primary realtime channel |

---

## Encryption Algorithms

| Algorithm | Usage | Parameters |
|-----------|-------|-----------|
| RSA-OAEP | Wrap AES session key per message | 2048-bit, SHA-256 |
| AES-GCM | Encrypt message body | 256-bit, 96-bit random IV |
| AES-KW | Wrap RSA private key for server storage | 256-bit |
| PBKDF2 | Derive AES-KW key from password | SHA-256, 310,000 iterations |

All via native `window.crypto.subtle` — zero third-party crypto dependencies.

https://drive.google.com/file/d/1SsiUtnW3iTSm8p3U7HLIwmmtfSfKJpi5/view?usp=drive_link