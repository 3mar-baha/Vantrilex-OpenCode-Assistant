export type { KeyPool, VaultBlob } from './vault.js';
export { encryptPool, decryptPool, FileVault } from './vault.js';
export { ROTATION_LIMIT } from './keyring.js';
export type { AcquiredKey, RolloverInfo } from './keyring.js';
export { Keyring } from './keyring.js';
export type { AudioCacheEntry, AudioCacheStats, AudioCacheConfig } from './cache.js';
export { normalizeForCache, cacheKey, AudioCache } from './cache.js';
