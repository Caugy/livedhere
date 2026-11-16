'use strict';

const session = require('express-session');

class SqliteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expire INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);
    `);
    this.getStmt = this.db.prepare('SELECT sess, expire FROM sessions WHERE sid = ?');
    this.setStmt = this.db.prepare(`
      INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire
    `);
    this.destroyStmt = this.db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.touchStmt = this.db.prepare('UPDATE sessions SET expire = ? WHERE sid = ?');
    this.allStmt = this.db.prepare('SELECT sess FROM sessions WHERE expire > ?');
    this.clearStmt = this.db.prepare('DELETE FROM sessions');
    this.lengthStmt = this.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expire > ?');
    this.purgeStmt = this.db.prepare('DELETE FROM sessions WHERE expire <= ?');

    setInterval(() => {
      try { this.purgeStmt.run(Date.now()); } catch { /* ignore */ }
    }, 60 * 60 * 1000).unref();
  }

  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid);
      if (!row) return cb(null, null);
      if (row.expire <= Date.now()) {
        this.destroyStmt.run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.sess));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      this.setStmt.run(sid, JSON.stringify(sess), expireAt(sess));
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.destroyStmt.run(sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      this.touchStmt.run(expireAt(sess), sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  all(cb) {
    try {
      const rows = this.allStmt.all(Date.now()).map((r) => JSON.parse(r.sess));
      cb(null, rows);
    } catch (err) {
      cb(err);
    }
  }

  clear(cb) {
    try {
      this.clearStmt.run();
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  length(cb) {
    try {
      cb(null, this.lengthStmt.get(Date.now()).n);
    } catch (err) {
      cb(err);
    }
  }
}

function expireAt(sess) {
  if (sess && sess.cookie && sess.cookie.expires) {
    return new Date(sess.cookie.expires).getTime();
  }
  return Date.now() + 7 * 24 * 60 * 60 * 1000;
}

module.exports = SqliteSessionStore;
