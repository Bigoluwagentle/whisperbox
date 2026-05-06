/**
 * crypto.js — WhisperBox E2EE Cryptography
 *
 * Private key wrapping strategy:
 *   Instead of AES-KW (which has browser bugs with wrapKey/PKCS8),
 *   we manually: exportKey('pkcs8') → encrypt with AES-GCM → store as JSON blob.
 *   On unwrap: decrypt with AES-GCM → importKey('pkcs8').
 *   This is functionally equivalent and works reliably across all browsers.
 *
 * Message encryption:
 *   AES-GCM 256-bit per message, key exchanged via RSA-OAEP 2048-bit.
 */

// ── Encoding helpers ──────────────────────────────────────────────────────────

export const bufToBase64 = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)));

export const base64ToBuf = (b64) =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;

// ── RSA-OAEP Key Pair ─────────────────────────────────────────────────────────

const RSA_PARAMS = {
  name: 'RSA-OAEP',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
};

export async function generateKeyPair() {
  return crypto.subtle.generateKey(
    RSA_PARAMS,
    true,                      // extractable — required so we can exportKey('pkcs8')
    ['encrypt', 'decrypt']
  );
}

export async function exportPublicKey(publicKey) {
  const buf = await crypto.subtle.exportKey('spki', publicKey);
  return bufToBase64(buf);
}

export async function importPublicKey(base64) {
  return crypto.subtle.importKey(
    'spki',
    base64ToBuf(base64),
    RSA_PARAMS,
    true,
    ['encrypt']
  );
}

// ── PBKDF2 salt generation ────────────────────────────────────────────────────

/** Generate a random 128-bit (16-byte) salt. Returns base64. */
export function generateSalt() {
  return bufToBase64(crypto.getRandomValues(new Uint8Array(16)).buffer);
}

// ── Derive AES-GCM key from password + PBKDF2 ────────────────────────────────

/**
 * Derive a 256-bit AES-GCM key from a password + PBKDF2 salt.
 * We use AES-GCM (not AES-KW) to avoid wrapKey browser incompatibilities.
 * Usage: ['encrypt','decrypt'] so we can use it to wrap/unwrap the private key.
 */
export async function deriveWrappingKey(password, saltBase64) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name:       'PBKDF2',
      salt:       base64ToBuf(saltBase64),
      iterations: 310_000,
      hash:       'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },  // AES-GCM, NOT AES-KW
    false,
    ['encrypt', 'decrypt']              // used to encrypt/decrypt the PKCS8 blob
  );
}

// ── Private key wrap / unwrap (AES-GCM over raw PKCS8 bytes) ─────────────────

/**
 * Wrap the RSA private key for server storage.
 *
 * Steps:
 *   1. Export private key as PKCS8 bytes (raw ArrayBuffer)
 *   2. Generate a random 12-byte IV for AES-GCM
 *   3. Encrypt the PKCS8 bytes with the AES-GCM wrapping key
 *   4. Return JSON: { iv: base64, ciphertext: base64 }
 *      serialised as a base64 string so the server treats it as an opaque blob.
 *
 * This is stored in the server's wrapped_private_key field.
 */
export async function wrapPrivateKey(privateKey, wrappingKey) {
  // 1. Export private key bytes — this is the step that was silently failing
  //    with wrapKey('pkcs8') in some Chromium builds.
  const pkcs8Bytes = await crypto.subtle.exportKey('pkcs8', privateKey);

  // 2. Random IV for AES-GCM
  const iv = crypto.getRandomValues(new Uint8Array(12));

  // 3. Encrypt the raw PKCS8 bytes
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    pkcs8Bytes
  );

  // 4. Pack into a JSON blob and base64-encode the whole thing
  const blob = JSON.stringify({
    iv:         bufToBase64(iv.buffer),
    ciphertext: bufToBase64(encrypted),
  });
  return btoa(blob); // base64-encode the JSON so the server gets a clean string
}

/**
 * Unwrap the RSA private key from the server-stored blob.
 * Reverses wrapPrivateKey exactly.
 */
export async function unwrapPrivateKey(wrappedBase64, wrappingKey) {
  // Decode outer base64 → JSON string → parse
  let blob;
  try {
    blob = JSON.parse(atob(wrappedBase64));
  } catch {
    throw new Error('wrapped_private_key is not in the expected format. Re-register this account.');
  }

  const iv         = base64ToBuf(blob.iv);
  const ciphertext = base64ToBuf(blob.ciphertext);

  // Decrypt → raw PKCS8 bytes
  let pkcs8Bytes;
  try {
    pkcs8Bytes = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      wrappingKey,
      ciphertext
    );
  } catch {
    throw new Error('Incorrect password — could not decrypt private key.');
  }

  // Import the PKCS8 bytes back as a usable CryptoKey
  return crypto.subtle.importKey(
    'pkcs8',
    pkcs8Bytes,
    RSA_PARAMS,
    true,           // keep extractable consistent
    ['decrypt']
  );
}

// ── AES-GCM message encryption ────────────────────────────────────────────────

export async function generateAESKey() {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,           // extractable — needed so we can export raw bytes for RSA wrapping
    ['encrypt', 'decrypt']
  );
}

/** Encrypt plaintext → { iv: base64, ciphertext: base64 } */
export async function encryptWithAES(aesKey, plaintext) {
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const buf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    new TextEncoder().encode(plaintext)
  );
  return { iv: bufToBase64(iv.buffer), ciphertext: bufToBase64(buf) };
}

/** Decrypt AES-GCM → plaintext string */
export async function decryptWithAES(aesKey, ivBase64, ciphertextBase64) {
  const buf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBuf(ivBase64) },
    aesKey,
    base64ToBuf(ciphertextBase64)
  );
  return new TextDecoder().decode(buf);
}

// ── RSA-OAEP wrap / unwrap of per-message AES key ────────────────────────────

/**
 * Wrap (encrypt) an AES key with an RSA-OAEP public key.
 * Exports the 32-byte raw AES key then encrypts with RSA-OAEP.
 */
export async function wrapAESKeyWithRSA(aesKey, rsaPublicKey) {
  const rawBytes = await crypto.subtle.exportKey('raw', aesKey); // 32 bytes
  const wrapped  = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    rsaPublicKey,
    rawBytes
  );
  return bufToBase64(wrapped);
}

/**
 * Unwrap (decrypt) a wrapped AES key using the RSA private key.
 */
export async function unwrapAESKeyWithRSA(wrappedBase64, rsaPrivateKey) {
  const rawBytes = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    rsaPrivateKey,
    base64ToBuf(wrappedBase64)
  );
  return crypto.subtle.importKey(
    'raw',
    rawBytes,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

// ── High-level E2EE message encrypt / decrypt ─────────────────────────────────

/**
 * Encrypt a plaintext message for a recipient.
 * Returns the payload object for WS frame or REST body.
 */
export async function encryptMessage(plaintext, recipientPublicKey, senderPublicKey) {
  const aesKey              = await generateAESKey();
  const { iv, ciphertext }  = await encryptWithAES(aesKey, plaintext);
  const encryptedKey        = await wrapAESKeyWithRSA(aesKey, recipientPublicKey);
  const encryptedKeyForSelf = await wrapAESKeyWithRSA(aesKey, senderPublicKey);
  return { ciphertext, iv, encryptedKey, encryptedKeyForSelf };
}

/** Decrypt a message received from another user (uses encryptedKey). */
export async function decryptReceivedMessage(payload, privateKey) {
  const aesKey = await unwrapAESKeyWithRSA(
    payload.encryptedKey || payload.encrypted_key,
    privateKey
  );
  return decryptWithAES(aesKey, payload.iv, payload.ciphertext);
}

/** Decrypt a sent message visible in own history (uses encryptedKeyForSelf). */
export async function decryptSentMessage(payload, privateKey) {
  const aesKey = await unwrapAESKeyWithRSA(
    payload.encryptedKeyForSelf || payload.encrypted_key_for_self,
    privateKey
  );
  return decryptWithAES(aesKey, payload.iv, payload.ciphertext);
}
