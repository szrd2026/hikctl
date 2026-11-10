// Emits a fixed AES-256-CBC test vector so an independent tool (OpenSSL) can confirm
// our activation crypto. Run: node tools/aes-vector.mjs
import { encodeAesCbc, buildEncryptPassword } from '../src/activate.js';

const key = 'a1b2c3d4e5f60718293a4b5c6d7e8f901a2b3c4d5e6f708192a3b4c5d6e7f801'; // 32 bytes
const iv = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';                                   // 16 bytes
const challenge = 'deadbeefcafebabe11223344556677889900aabbccddeeff0102030405060708';
const password = 'Hik@2026Y2S4M';
const plain = challenge.substring(0, 16) + password;

console.log(JSON.stringify({
  key,
  iv,
  plain,
  cipherHex: encodeAesCbc(plain, key, iv),
  encPwd: buildEncryptPassword(challenge, password, iv),
}, null, 2));