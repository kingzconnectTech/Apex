const crypto = require('crypto');
const { TTL } = require('./config');

class TTLCache {
  constructor() {
    this._store = new Map();
  }

  _hash(key, params) {
    const paramStr = params && typeof params === 'object'
      ? JSON.stringify(params, Object.keys(params).sort())
      : String(params ?? '');
    const raw = `${key}::${paramStr}`;
    return crypto.createHash('md5').update(raw).digest('hex');
  }

  set(key, params, data, ttlMs = TTL.DEFAULT) {
    const hash = this._hash(key, params);
    this._store.set(hash, { data, expiresAt: Date.now() + ttlMs });
    return data;
  }

  get(key, params) {
    const hash = this._hash(key, params);
    const entry = this._store.get(hash);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this._store.delete(hash);
      return null;
    }
    return entry.data;
  }

  has(key, params) {
    return this.get(key, params) !== null;
  }

  purgeExpired() {
    const now = Date.now();
    let removed = 0;
    for (const [k, v] of this._store.entries()) {
      if (v.expiresAt < now) {
        this._store.delete(k);
        removed++;
      }
    }
    return removed;
  }

  size() {
    return this._store.size;
  }
}

const sharedCache = new TTLCache();

module.exports = { TTLCache, sharedCache };
