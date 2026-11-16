'use strict';

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const Database = require('better-sqlite3');
const { parseRatings, parseRatingsJson, aggregateRatings } = require('./ratings');
const policy = require('./policy');
const uploads = require('./uploads');
const contentFilter = require('./content-filter');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'reviews.db');
const BCRYPT_ROUNDS = 10;

const DEMO_EMAIL = 'demo@livedhere.example';
const DEMO_PASSWORD = 'LivedHereDemo1';
const DEMO_NAME = 'Demo Resident';
const { MOD_EMAIL, MOD_PASSWORD, MOD_NAME, AUTO_HIDE_THRESHOLD, AUTO_HIDE_REASON } = policy;

const STREET_ABBR = [
  [/\bstreet\b/g, 'st'],
  [/\bavenue\b/g, 'ave'],
  [/\broad\b/g, 'rd'],
  [/\blane\b/g, 'ln'],
  [/\bboulevard\b/g, 'blvd'],
  [/\bdrive\b/g, 'dr'],
  [/\bcourt\b/g, 'ct'],
  [/\bplace\b/g, 'pl'],
  [/\bapartment\b/g, 'apt'],
  [/\bsuite\b/g, 'ste'],
];

let db;

function getDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (userCount === 0) seed(db);
  ensureDemoAccounts(db);
  cleanupStrayTestData(db);
  ensureDemoModerationFixtures(db);
  ensureAdminAccount(db);
  return db;
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      is_demo INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS properties (
      id INTEGER PRIMARY KEY,
      street TEXT NOT NULL,
      city TEXT NOT NULL,
      state TEXT NOT NULL,
      zip TEXT NOT NULL,
      street_norm TEXT NOT NULL,
      city_norm TEXT NOT NULL,
      state_norm TEXT NOT NULL,
      zip_norm TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (street_norm, city_norm, state_norm, zip_norm)
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY,
      property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      occupancy_type TEXT NOT NULL CHECK (occupancy_type IN ('rented', 'owned')),
      unit TEXT,
      year_from INTEGER,
      year_to INTEGER,
      still_living INTEGER NOT NULL DEFAULT 0,
      review_text TEXT,
      pros TEXT,
      cons TEXT,
      would_recommend INTEGER,
      ratings_json TEXT NOT NULL DEFAULT '{}',
      anonymous INTEGER NOT NULL DEFAULT 0,
      is_sample INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT,
      CHECK (would_recommend IS NULL OR would_recommend IN (0, 1))
    );

    CREATE INDEX IF NOT EXISTS idx_reviews_property ON reviews(property_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_user ON reviews(user_id);
    CREATE INDEX IF NOT EXISTS idx_properties_search ON properties(city_norm, state_norm, zip_norm);
  `);
  migrateExtras(database);
}

function tableColumns(database, table) {
  return database.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function addColumn(database, table, column, definition) {
  if (!tableColumns(database, table).includes(column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function migrateExtras(database) {
  addColumn(database, 'users', 'role', "TEXT NOT NULL DEFAULT 'user'");
  addColumn(database, 'users', 'status', "TEXT NOT NULL DEFAULT 'active'");
  addColumn(database, 'users', 'suspended_at', 'TEXT');
  addColumn(database, 'users', 'suspend_reason', 'TEXT');
  addColumn(database, 'users', 'suspended_by', 'INTEGER');
  addColumn(database, 'reviews', 'hidden', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(database, 'reviews', 'hidden_reason', 'TEXT');
  addColumn(database, 'reviews', 'hidden_at', 'TEXT');
  addColumn(database, 'reviews', 'hidden_by', 'INTEGER');
  addColumn(database, 'reviews', 'hidden_source', 'TEXT');
  addColumn(database, 'reviews', 'moderation_status', "TEXT NOT NULL DEFAULT 'published'");
  addColumn(database, 'reviews', 'flagged_json', 'TEXT');
  addColumn(database, 'reviews', 'rejected_reason', 'TEXT');
  addColumn(database, 'reviews', 'moderation_decided_at', 'TEXT');
  addColumn(database, 'reviews', 'moderation_decided_by', 'INTEGER');

  database.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY,
      review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
      reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reason TEXT NOT NULL,
      details TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (review_id, reporter_id)
    );
    CREATE INDEX IF NOT EXISTS idx_reports_review ON reports(review_id, status);

    CREATE TABLE IF NOT EXISTS moderation_actions (
      id INTEGER PRIMARY KEY,
      actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      review_id INTEGER,
      target_user_id INTEGER,
      verification_id INTEGER,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mod_actions_created ON moderation_actions(created_at DESC);

    CREATE TABLE IF NOT EXISTS verification_requests (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      review_id INTEGER REFERENCES reviews(id) ON DELETE SET NULL,
      property_id INTEGER REFERENCES properties(id) ON DELETE SET NULL,
      occupancy_type TEXT NOT NULL CHECK (occupancy_type IN ('rented', 'owned')),
      document_type TEXT NOT NULL,
      stored_filename TEXT,
      original_filename TEXT,
      mime_type TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      year_from INTEGER,
      year_to INTEGER,
      still_living INTEGER NOT NULL DEFAULT 0,
      reject_reason TEXT,
      decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      decided_at TEXT,
      confirmed_year_from INTEGER,
      confirmed_year_to INTEGER,
      confirmed_still_living INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_verifications_status ON verification_requests(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_verifications_user ON verification_requests(user_id, property_id);
  `);
  addColumn(database, 'reports', 'details_flagged_json', 'TEXT');
}

const PUBLIC_REVIEW_SQL = "(hidden = 0 AND COALESCE(moderation_status, 'published') = 'published')";
const PUBLIC_REVIEW_SQL_R = "(r.hidden = 0 AND COALESCE(r.moderation_status, 'published') = 'published')";

function isPubliclyListed(review) {
  return Boolean(review) && !review.hidden && (review.moderation_status || 'published') === 'published';
}

function reviewFilterFields(data) {
  const result = contentFilter.scanReview({
    reviewText: data.reviewText,
    pros: data.pros,
    cons: data.cons,
  });
  if (result.flagged) {
    return {
      moderation_status: 'pending',
      flagged_json: JSON.stringify(result.matches),
      rejected_reason: null,
    };
  }
  return {
    moderation_status: 'published',
    flagged_json: null,
    rejected_reason: null,
  };
}

function normalizeStreet(value) {
  let text = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\s+/g, ' ');
  for (const [pattern, replacement] of STREET_ABBR) {
    text = text.replace(pattern, replacement);
  }
  return text.trim();
}

function normalizeCity(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeState(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeZip(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.slice(0, 5);
}

function formatAddress(property, { unit } = {}) {
  if (!property) return '';
  const line = unit ? `${property.street}, Unit ${unit}` : property.street;
  return `${line}, ${property.city}, ${property.state} ${property.zip}`;
}

function hydrateUser(row) {
  if (!row) return null;
  const user = {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    is_demo: Boolean(row.is_demo),
    role: row.role || 'user',
    status: row.status || 'active',
    suspended_at: row.suspended_at || null,
    suspend_reason: row.suspend_reason || null,
    suspended_by: row.suspended_by || null,
    created_at: row.created_at,
  };
  user.isStaff = policy.isStaff(user);
  user.isSuspended = policy.isSuspended(user);
  return user;
}

function createUser({ email, password, displayName, isDemo = false, role = 'user' }) {
  const passwordHash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const safeRole = ['user', 'moderator', 'admin'].includes(role) ? role : 'user';
  const result = getDb()
    .prepare(
      'INSERT INTO users (email, password_hash, display_name, is_demo, role, status) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(email.trim(), passwordHash, displayName.trim(), isDemo ? 1 : 0, safeRole, 'active');
  return getUserById(result.lastInsertRowid);
}

function getUserById(id) {
  return hydrateUser(
    getDb()
      .prepare(
        'SELECT id, email, display_name, is_demo, role, status, suspended_at, suspend_reason, suspended_by, created_at FROM users WHERE id = ?'
      )
      .get(id)
  );
}

function getUserByEmail(email) {
  return getDb().prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim()) || null;
}

async function authenticate(email, password) {
  const user = getUserByEmail(email);
  if (!user) return null;
  const ok = await bcrypt.compare(String(password || ''), user.password_hash);
  if (!ok) return null;
  return getUserById(user.id);
}

function emailTaken(email, exceptId = null) {
  const row = getDb()
    .prepare('SELECT id FROM users WHERE email = ? AND (? IS NULL OR id != ?)')
    .get(String(email || '').trim(), exceptId, exceptId);
  return Boolean(row);
}

function findProperty({ street, city, state, zip }) {
  return getDb()
    .prepare(
      `SELECT * FROM properties
       WHERE street_norm = ? AND city_norm = ? AND state_norm = ? AND zip_norm = ?`
    )
    .get(normalizeStreet(street), normalizeCity(city), normalizeState(state), normalizeZip(zip)) || null;
}

function createProperty({ street, city, state, zip }) {
  const result = getDb()
    .prepare(
      `INSERT INTO properties (street, city, state, zip, street_norm, city_norm, state_norm, zip_norm)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      String(street).trim(),
      String(city).trim(),
      normalizeState(state),
      normalizeZip(zip) || String(zip).trim(),
      normalizeStreet(street),
      normalizeCity(city),
      normalizeState(state),
      normalizeZip(zip)
    );
  return getPropertyById(result.lastInsertRowid);
}

function findOrCreateProperty(address) {
  return findProperty(address) || createProperty(address);
}

function getPropertyById(id, options = {}) {
  const property = getDb().prepare('SELECT * FROM properties WHERE id = ?').get(id);
  if (!property) return null;
  return decorateProperty(property, options);
}

function decorateProperty(property, options = {}) {
  const occupancy = options.occupancy || null;
  const viewerId = options.viewerId || null;
  const verifiedOnly = Boolean(options.verifiedOnly);
  const listed = listReviewsForProperty(property.id, { occupancy, viewerId });
  const publicReviews = listed.filter((r) => isPubliclyListed(r));
  const aggregates = aggregateRatings(publicReviews);
  const visible = publicReviews.filter((r) => !verifiedOnly || r.verified);
  const display = listed.filter((r) => (!r.hidden || r.user_id === viewerId) && (!verifiedOnly || r.verified || (r.hidden && r.user_id === viewerId)));
  const recommendable = visible.filter((r) => r.would_recommend !== null && r.would_recommend !== undefined);
  const recommendYes = recommendable.filter((r) => r.would_recommend === 1).length;
  const allCounts = getDb()
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN occupancy_type = 'rented' THEN 1 ELSE 0 END) AS rented,
         SUM(CASE WHEN occupancy_type = 'owned' THEN 1 ELSE 0 END) AS owned
       FROM reviews WHERE property_id = ? AND hidden = 0 AND COALESCE(moderation_status, 'published') = 'published'`
    )
    .get(property.id);
  const verifiedCount = publicReviews.filter((r) => r.verified).length;

  return {
    ...property,
    address: formatAddress(property),
    reviews: display,
    aggregates,
    reviewCount: verifiedOnly ? visible.length : publicReviews.length,
    rentedCount: allCounts.rented || 0,
    ownedCount: allCounts.owned || 0,
    verifiedCount,
    filteredRentedCount: visible.filter((r) => r.occupancy_type === 'rented').length,
    filteredOwnedCount: visible.filter((r) => r.occupancy_type === 'owned').length,
    recommendPercent: recommendable.length
      ? Math.round((recommendYes / recommendable.length) * 100)
      : null,
    recommendCount: recommendable.length,
  };
}

function listReviewsForProperty(propertyId, { occupancy = null, viewerId = null } = {}) {
  const clauses = ['r.property_id = ?'];
  const params = [propertyId];
  if (occupancy) {
    clauses.push('r.occupancy_type = ?');
    params.push(occupancy);
  }
  if (viewerId) {
    clauses.push(`(${PUBLIC_REVIEW_SQL_R} OR r.user_id = ?)`);
    params.push(viewerId);
  } else {
    clauses.push(PUBLIC_REVIEW_SQL_R);
  }
  const rows = getDb()
    .prepare(
      `SELECT r.*, u.display_name, u.email
       FROM reviews r JOIN users u ON u.id = r.user_id
       WHERE ${clauses.join(' AND ')}
       ORDER BY r.created_at DESC, r.id DESC`
    )
    .all(...params);
  const verified = approvedVerificationMap(propertyId);
  return rows.map((row) => hydrateReview(row, verified));
}

function approvedVerificationMap(propertyId) {
  const rows = getDb()
    .prepare(
      `SELECT user_id, occupancy_type, confirmed_year_from, confirmed_year_to, confirmed_still_living, decided_at
       FROM verification_requests
       WHERE property_id = ? AND status = 'approved'`
    )
    .all(propertyId);
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.user_id}:${row.occupancy_type}`, row);
  }
  return map;
}

function lookupVerified(userId, occupancyType, propertyId, cache) {
  const map = cache || approvedVerificationMap(propertyId);
  return map.get(`${userId}:${occupancyType}`) || null;
}

function hydrateReview(row, verifiedMap) {
  const ratings = parseRatingsJson(row.ratings_json);
  const ratingCount = Object.keys(ratings).length;
  const verification = row.property_id
    ? lookupVerified(row.user_id, row.occupancy_type, row.property_id, verifiedMap)
    : null;
  const verified = Boolean(verification);
  const badge = verified ? policy.verificationBadge(row.occupancy_type) : null;
  const moderationStatus = row.moderation_status || 'published';
  let flaggedMatches = [];
  if (row.flagged_json) {
    try { flaggedMatches = JSON.parse(row.flagged_json) || []; } catch { flaggedMatches = []; }
  }
  let reviewerName;
  if (row.anonymous) {
    reviewerName = contentFilter.anonymousLabel({ verified, occupancy_type: row.occupancy_type });
  } else {
    reviewerName = row.display_name || 'A resident';
  }
  return {
    ...row,
    ratings,
    ratingCount,
    still_living: Boolean(row.still_living),
    anonymous: Boolean(row.anonymous),
    is_sample: Boolean(row.is_sample),
    hidden: Boolean(row.hidden),
    moderation_status: moderationStatus,
    isPending: moderationStatus === 'pending',
    isRejected: moderationStatus === 'rejected',
    flaggedMatches,
    rejected_reason: row.rejected_reason || null,
    verified,
    verificationBadge: badge,
    verification,
    reviewerName,
  };
}

function getReviewById(id) {
  const row = getDb()
    .prepare(
      `SELECT r.*, u.display_name, u.email
       FROM reviews r JOIN users u ON u.id = r.user_id
       WHERE r.id = ?`
    )
    .get(id);
  return row ? hydrateReview(row) : null;
}

function insertReview(data) {
  const ratings = parseRatings(data.ratings);
  const skipFilter = Boolean(data.skipFilter);
  const filter = skipFilter
    ? {
        moderation_status: data.moderationStatus || 'published',
        flagged_json: data.flaggedJson || null,
        rejected_reason: data.rejectedReason || null,
      }
    : reviewFilterFields(data);
  const result = getDb()
    .prepare(
      `INSERT INTO reviews (
         property_id, user_id, occupancy_type, unit, year_from, year_to, still_living,
         review_text, pros, cons, would_recommend, ratings_json, anonymous, is_sample,
         moderation_status, flagged_json, rejected_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      data.propertyId,
      data.userId,
      data.occupancyType,
      data.unit || null,
      data.yearFrom || null,
      data.stillLiving ? null : data.yearTo || null,
      data.stillLiving ? 1 : 0,
      data.reviewText || null,
      data.pros || null,
      data.cons || null,
      data.wouldRecommend,
      JSON.stringify(ratings),
      data.anonymous ? 1 : 0,
      data.isSample ? 1 : 0,
      filter.moderation_status,
      filter.flagged_json,
      filter.rejected_reason
    );
  return getReviewById(result.lastInsertRowid);
}

function updateReview(id, data) {
  const ratings = parseRatings(data.ratings);
  const filter = reviewFilterFields(data);
  getDb()
    .prepare(
      `UPDATE reviews SET
         property_id = ?, occupancy_type = ?, unit = ?, year_from = ?, year_to = ?,
         still_living = ?, review_text = ?, pros = ?, cons = ?, would_recommend = ?,
         ratings_json = ?, anonymous = ?, updated_at = datetime('now'),
         moderation_status = ?, flagged_json = ?, rejected_reason = ?,
         moderation_decided_at = NULL, moderation_decided_by = NULL
       WHERE id = ?`
    )
    .run(
      data.propertyId,
      data.occupancyType,
      data.unit || null,
      data.yearFrom || null,
      data.stillLiving ? null : data.yearTo || null,
      data.stillLiving ? 1 : 0,
      data.reviewText || null,
      data.pros || null,
      data.cons || null,
      data.wouldRecommend,
      JSON.stringify(ratings),
      data.anonymous ? 1 : 0,
      filter.moderation_status,
      filter.flagged_json,
      filter.rejected_reason,
      id
    );
  return getReviewById(id);
}

function updateDisplayName(userId, displayName) {
  getDb().prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, userId);
  return getUserById(userId);
}

function presentReview(review, { viewerId = null, forDashboard = false } = {}) {
  if (!review) return review;
  const out = { ...review };
  const isAuthor = Boolean(viewerId && review.user_id === viewerId);
  if (!forDashboard) {
    delete out.email;
    if (review.anonymous && !isAuthor) {
      delete out.user_id;
      delete out.display_name;
    } else if (review.anonymous) {
      delete out.display_name;
    }
  }
  return out;
}

function presentProperty(property, options = {}) {
  if (!property) return property;
  return {
    ...property,
    reviews: (property.reviews || []).map((review) => presentReview(review, options)),
  };
}

function deleteReview(id) {
  const review = getReviewById(id);
  if (!review) return null;
  getDb().prepare('DELETE FROM reviews WHERE id = ?').run(id);
  const left = getDb().prepare('SELECT COUNT(*) AS n FROM reviews WHERE property_id = ?').get(review.property_id).n;
  if (left === 0) {
    getDb().prepare('DELETE FROM properties WHERE id = ?').run(review.property_id);
  }
  return review;
}

function searchProperties(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const rows = getDb()
    .prepare(
      `SELECT p.*,
         (SELECT COUNT(*) FROM reviews r WHERE r.property_id = p.id AND r.hidden = 0 AND COALESCE(r.moderation_status, 'published') = 'published') AS review_count
       FROM properties p
       WHERE p.street LIKE ? COLLATE NOCASE
          OR p.city LIKE ? COLLATE NOCASE
          OR p.state LIKE ? COLLATE NOCASE
          OR p.zip LIKE ?
          OR (p.street || ' ' || p.city || ' ' || p.state || ' ' || p.zip) LIKE ? COLLATE NOCASE
       ORDER BY review_count DESC, p.city, p.street`
    )
    .all(like, like, like, like, like);
  return rows.map((row) => {
    const property = getPropertyById(row.id);
    return property;
  });
}

function featuredProperties(limit = 4) {
  const rows = getDb()
    .prepare(
      `SELECT p.id,
         (SELECT COUNT(*) FROM reviews r WHERE r.property_id = p.id AND r.hidden = 0 AND COALESCE(r.moderation_status, 'published') = 'published') AS review_count
       FROM properties p
       WHERE review_count > 0
       ORDER BY review_count DESC, p.id
       LIMIT ?`
    )
    .all(limit);
  return rows.map((row) => getPropertyById(row.id));
}

function recentReviews(limit = 6) {
  const rows = getDb()
    .prepare(
      `SELECT r.*, u.display_name, u.email,
              p.street, p.city, p.state, p.zip
       FROM reviews r
       JOIN users u ON u.id = r.user_id
       JOIN properties p ON p.id = r.property_id
       WHERE r.hidden = 0 AND COALESCE(r.moderation_status, 'published') = 'published'
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT ?`
    )
    .all(limit);
  return rows.map((row) => ({
    ...hydrateReview(row),
    property: {
      id: row.property_id,
      street: row.street,
      city: row.city,
      state: row.state,
      zip: row.zip,
      address: formatAddress(row),
    },
  }));
}

function reviewsByUser(userId) {
  const rows = getDb()
    .prepare(
      `SELECT r.*, u.display_name, u.email,
              p.street, p.city, p.state, p.zip
       FROM reviews r
       JOIN users u ON u.id = r.user_id
       JOIN properties p ON p.id = r.property_id
       WHERE r.user_id = ?
       ORDER BY r.created_at DESC, r.id DESC`
    )
    .all(userId);
  return rows.map((row) => ({
    ...hydrateReview(row),
    property: {
      id: row.property_id,
      street: row.street,
      city: row.city,
      state: row.state,
      zip: row.zip,
      address: formatAddress(row),
    },
  }));
}

function siteStats() {
  const database = getDb();
  return {
    properties: database
      .prepare(
        "SELECT COUNT(*) AS n FROM properties p WHERE EXISTS (SELECT 1 FROM reviews r WHERE r.property_id = p.id AND r.hidden = 0 AND COALESCE(r.moderation_status, 'published') = 'published')"
      )
      .get().n,
    reviews: database.prepare("SELECT COUNT(*) AS n FROM reviews WHERE hidden = 0 AND COALESCE(moderation_status, 'published') = 'published'").get().n,
    users: database.prepare('SELECT COUNT(*) AS n FROM users').get().n,
  };
}

function seed(database) {
  const insertUser = database.prepare(
    'INSERT INTO users (email, password_hash, display_name, is_demo, role, status) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const users = [
    { email: DEMO_EMAIL, password: DEMO_PASSWORD, display_name: DEMO_NAME, is_demo: 1, role: 'user' },
    { email: MOD_EMAIL, password: MOD_PASSWORD, display_name: MOD_NAME, is_demo: 1, role: 'moderator' },
    { email: 'alex@example.test', password: 'unused-alex-' + Math.random(), display_name: 'Alex Rivera', is_demo: 0, role: 'user' },
    { email: 'jordan@example.test', password: 'unused-jordan-' + Math.random(), display_name: 'Jordan Hale', is_demo: 0, role: 'user' },
    { email: 'sam@example.test', password: 'unused-sam-' + Math.random(), display_name: 'Sam Okonkwo', is_demo: 0, role: 'user' },
    { email: 'riley@example.test', password: 'unused-riley-' + Math.random(), display_name: 'Riley Nguyen', is_demo: 0, role: 'user' },
  ];
  const userIds = {};
  for (const user of users) {
    const result = insertUser.run(
      user.email,
      bcrypt.hashSync(user.password, BCRYPT_ROUNDS),
      user.display_name,
      user.is_demo,
      user.role,
      'active'
    );
    userIds[user.email] = result.lastInsertRowid;
  }

  const insertProperty = database.prepare(
    `INSERT INTO properties (street, city, state, zip, street_norm, city_norm, state_norm, zip_norm)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const properties = [
    { key: 'example', street: '123 Example St', city: 'Springfield', state: 'IL', zip: '62701' },
    { key: 'sample', street: '456 Sample Ave', city: 'Portland', state: 'OR', zip: '97201' },
    { key: 'demo', street: '789 Demo Lane', city: 'Austin', state: 'TX', zip: '78701' },
    { key: 'placeholder', street: '12 Placeholder Rd', city: 'Brooklyn', state: 'NY', zip: '11201' },
    { key: 'fiction', street: '100 Fiction Blvd', city: 'Denver', state: 'CO', zip: '80202' },
  ];
  const propertyIds = {};
  for (const property of properties) {
    const result = insertProperty.run(
      property.street,
      property.city,
      property.state,
      property.zip,
      normalizeStreet(property.street),
      normalizeCity(property.city),
      normalizeState(property.state),
      normalizeZip(property.zip)
    );
    propertyIds[property.key] = result.lastInsertRowid;
  }

  const insertReview = database.prepare(
    `INSERT INTO reviews (
       property_id, user_id, occupancy_type, unit, year_from, year_to, still_living,
       review_text, pros, cons, would_recommend, ratings_json, anonymous, is_sample, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  );

  const reviews = [
    {
      property: 'example',
      user: DEMO_EMAIL,
      occupancy_type: 'rented',
      unit: '2B',
      year_from: 2022,
      year_to: 2025,
      still_living: 0,
      anonymous: 0,
      would_recommend: 1,
      created_at: '2025-06-12 14:00:00',
      review_text:
        'I rented unit 2B at 123 Example St for three years. The layout is smarter than it looks from the street, and the kitchen was redone right before I moved in. Management usually answered maintenance requests within a couple of days. The street itself is quiet at night, though you can hear the upstairs neighbors on weekends. This is sample data for the LivedHere demo.',
      pros: 'Updated kitchen, responsive landlord, walkable to a grocery store.',
      cons: 'Thin floors, street parking only, summer AC struggled on the top floor.',
      ratings: {
        overall: 4, value: 4, landlord_responsiveness: 4, deposit_fairness: 5,
        maintenance: 4, build_quality: 3, pests: 5, mold: 5, plumbing: 4,
        heating: 4, cooling: 3, insulation: 3, air_quality: 4, utilities: 3,
        internet: 4, noise_inside: 3, noise_outside: 4, light: 4, layout: 5,
        storage: 3, kitchen: 5, bathrooms: 4, laundry: 3, parking: 2,
        outdoor: 3, pets: 4, accessibility: 3, safety: 4, neighborhood: 4,
        neighbors: 3, walkability: 5, transit: 3, amenities: 5, commute: 4,
      },
    },
    {
      property: 'example',
      user: 'alex@example.test',
      occupancy_type: 'owned',
      year_from: 2018,
      year_to: 2022,
      still_living: 0,
      anonymous: 0,
      would_recommend: 1,
      created_at: '2022-09-03 10:15:00',
      review_text:
        'We owned this Example Street house before selling in 2022. Solid bones, original hardwood, and a backyard that felt bigger than the lot map suggests. The HOA (tiny three-unit setup) was low-drama and cheap. Insulation is the weak spot — winter drafts along the north windows. Sample review only.',
      pros: 'Yard, hardwood floors, easy HOA, great block for evening walks.',
      cons: 'Drafty windows, older electrical, street gets busy at school pickup.',
      ratings: {
        overall: 4, value: 5, hoa: 5, maintenance: 3, build_quality: 4,
        pests: 4, heating: 3, cooling: 3, insulation: 2, utilities: 3,
        noise_outside: 3, light: 5, layout: 4, storage: 4, kitchen: 3,
        outdoor: 5, parking: 3, safety: 4, neighborhood: 5, neighbors: 5,
        walkability: 4, schools: 4, amenities: 4,
      },
    },
    {
      property: 'example',
      user: 'jordan@example.test',
      occupancy_type: 'rented',
      unit: '1A',
      year_from: 2024,
      year_to: null,
      still_living: 1,
      anonymous: 1,
      would_recommend: 0,
      created_at: '2026-02-18 18:40:00',
      review_text:
        'Still living in 1A at this sample address. The location is convenient, but pest control has been a revolving issue and it took weeks to get a leaking bathroom fan replaced. I would think hard before signing another year. (Example review.)',
      pros: 'Convenient location, in-unit laundry, decent natural light in the front room.',
      cons: 'Slow repairs, recurring pests, noisy pipes at night.',
      ratings: {
        overall: 2, value: 2, landlord_responsiveness: 2, deposit_fairness: 3,
        maintenance: 2, pests: 1, mold: 3, plumbing: 2, internet: 4,
        noise_inside: 2, laundry: 4, safety: 3, neighborhood: 4, amenities: 4,
      },
    },
    {
      property: 'sample',
      user: 'sam@example.test',
      occupancy_type: 'rented',
      unit: '4C',
      year_from: 2021,
      year_to: 2024,
      still_living: 0,
      anonymous: 0,
      would_recommend: 1,
      created_at: '2024-08-21 09:00:00',
      review_text:
        '456 Sample Ave in Portland was a good rental for the price. The building is 1990s stock — nothing fancy, but the heat worked and the management company actually followed through on a deposit return. Street noise from the corridor is the main tradeoff. Sample data.',
      pros: 'Fair management, reliable heat, close to transit.',
      cons: 'Street noise, small closets, dated bathrooms.',
      ratings: {
        overall: 4, value: 5, landlord_responsiveness: 4, deposit_fairness: 5,
        heating: 5, cooling: 3, noise_outside: 2, storage: 2, bathrooms: 3,
        transit: 5, walkability: 5, parking: 3, pets: 4, neighborhood: 4,
        amenities: 5, commute: 5,
      },
    },
    {
      property: 'sample',
      user: DEMO_EMAIL,
      occupancy_type: 'rented',
      year_from: 2019,
      year_to: 2021,
      still_living: 0,
      anonymous: 0,
      would_recommend: 1,
      created_at: '2021-11-02 16:20:00',
      review_text:
        'I lived at this Sample Avenue building before the current mid-rise next door went up. At the time it felt calm and a little worn in a comfortable way. Cell reception was spotty in the back bedrooms. This is an example review for testing LivedHere.',
      pros: 'Calm block (at the time), friendly neighbors, workable kitchen.',
      cons: 'Spotty cell service, limited visitor parking.',
      ratings: {
        overall: 4, value: 4, landlord_responsiveness: 3, internet: 2,
        kitchen: 4, neighbors: 5, parking: 2, neighborhood: 4, layout: 3,
      },
    },
    {
      property: 'demo',
      user: 'riley@example.test',
      occupancy_type: 'owned',
      year_from: 2020,
      year_to: null,
      still_living: 1,
      anonymous: 0,
      would_recommend: 1,
      created_at: '2026-01-09 12:00:00',
      review_text:
        'We still own 789 Demo Lane. The house itself has been lovely — light from three directions, a usable backyard, and a kitchen we finally finished remodeling last year. The HOA for the small lane association is organized but a bit strict about fences. Sample listing only; this address is fictional.',
      pros: 'Light, backyard, strong build quality, walkable cafes.',
      cons: 'Strict HOA aesthetic rules, tight driveway, summer water bills.',
      ratings: {
        overall: 5, value: 4, hoa: 3, maintenance: 4, build_quality: 5,
        pests: 5, mold: 5, plumbing: 4, heating: 4, cooling: 4, insulation: 4,
        utilities: 3, light: 5, layout: 5, storage: 4, kitchen: 5, bathrooms: 4,
        outdoor: 5, parking: 3, pets: 4, safety: 5, neighborhood: 5,
        neighbors: 4, walkability: 5, schools: 4, amenities: 5, commute: 3,
      },
    },
    {
      property: 'demo',
      user: 'jordan@example.test',
      occupancy_type: 'rented',
      year_from: 2016,
      year_to: 2019,
      still_living: 0,
      anonymous: 1,
      would_recommend: 1,
      created_at: '2019-05-14 11:11:00',
      review_text:
        'Rented this Demo Lane house years ago, before the current owners. Even then it felt well cared for. The only real complaint was weak water pressure on the second floor. Example review.',
      pros: 'Quiet lane, good neighbors, solid condition even as a rental.',
      cons: 'Second-floor water pressure, limited closet space in the smaller bedroom.',
      ratings: {
        overall: 4, value: 4, landlord_responsiveness: 5, plumbing: 2,
        neighborhood: 5, neighbors: 5, storage: 3, safety: 4,
      },
    },
    {
      property: 'placeholder',
      user: 'alex@example.test',
      occupancy_type: 'rented',
      unit: '3',
      year_from: 2023,
      year_to: 2026,
      still_living: 0,
      anonymous: 0,
      would_recommend: 0,
      created_at: '2026-03-01 08:30:00',
      review_text:
        '12 Placeholder Rd looks charming in photos. In person, the walk-up is steep, the walls are thin, and a mold smell lingered in the bathroom no matter how much we aired it out. Great restaurants nearby, which is the only reason this was tolerable. Sample review for a fictional Brooklyn address.',
      pros: 'Restaurants and grocery within a few blocks, lots of natural light in the front.',
      cons: 'Mold smell, thin walls, steep stairs, no laundry in the building.',
      ratings: {
        overall: 2, value: 2, landlord_responsiveness: 3, deposit_fairness: 2,
        mold: 1, air_quality: 2, noise_inside: 1, light: 5, laundry: 1,
        accessibility: 1, walkability: 5, transit: 5, amenities: 5,
        safety: 3, neighborhood: 4,
      },
    },
    {
      property: 'fiction',
      user: 'sam@example.test',
      occupancy_type: 'owned',
      year_from: 2015,
      year_to: 2024,
      still_living: 0,
      anonymous: 0,
      would_recommend: 1,
      created_at: '2024-12-19 19:45:00',
      review_text:
        '100 Fiction Blvd was our Denver home for almost a decade. Summers are intense without shade on the west side, but the location made commuting easy and the neighborhood stayed friendly. We would buy here again. This is demo content, not a real address.',
      pros: 'Commute, neighbors, attached garage, updated electrical.',
      cons: 'West-facing heat in summer, small backyard, HOA parking rules.',
      ratings: {
        overall: 5, value: 4, hoa: 3, build_quality: 4, cooling: 3, heating: 5,
        outdoor: 3, parking: 4, neighborhood: 5, neighbors: 5, commute: 5,
        safety: 4, schools: 4, amenities: 4, layout: 4, storage: 4,
      },
    },
  ];

  for (const review of reviews) {
    insertReview.run(
      propertyIds[review.property],
      userIds[review.user],
      review.occupancy_type,
      review.unit || null,
      review.year_from || null,
      review.still_living ? null : review.year_to || null,
      review.still_living ? 1 : 0,
      review.review_text,
      review.pros,
      review.cons,
      review.would_recommend,
      JSON.stringify(review.ratings),
      review.anonymous ? 1 : 0,
      review.created_at
    );
  }
}


function logAction({ actorId = null, action, reviewId = null, targetUserId = null, verificationId = null, details = null }) {
  getDb()
    .prepare(
      `INSERT INTO moderation_actions (actor_id, action, review_id, target_user_id, verification_id, details)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      actorId,
      action,
      reviewId,
      targetUserId,
      verificationId,
      details == null || typeof details === 'string' ? details : JSON.stringify(details)
    );
}

function openReportCount(reviewId) {
  return getDb()
    .prepare("SELECT COUNT(*) AS n FROM reports WHERE review_id = ? AND status = 'open'")
    .get(reviewId).n;
}

function getReportForUser(reviewId, reporterId) {
  return getDb()
    .prepare('SELECT * FROM reports WHERE review_id = ? AND reporter_id = ?')
    .get(reviewId, reporterId) || null;
}

function listReportsForReview(reviewId) {
  return getDb()
    .prepare(
      `SELECT p.*, u.display_name AS reporter_name, u.email AS reporter_email
       FROM reports p JOIN users u ON u.id = p.reporter_id
       WHERE p.review_id = ?
       ORDER BY p.created_at ASC, p.id ASC`
    )
    .all(reviewId);
}

function createReport({ reviewId, reporterId, reason, details }) {
  const review = getReviewById(reviewId);
  if (!review) {
    const err = new Error('Review not found.');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (review.user_id === reporterId) {
    const err = new Error('You cannot report your own review.');
    err.code = 'OWN_REVIEW';
    throw err;
  }
  if (getReportForUser(reviewId, reporterId)) {
    const err = new Error('You have already reported this review.');
    err.code = 'ALREADY_REPORTED';
    throw err;
  }
  if (!policy.REPORT_REASONS.some((r) => r.id === reason)) {
    const err = new Error('Please choose a report reason.');
    err.code = 'INVALID_REASON';
    throw err;
  }
  const detailsScan = contentFilter.scan(details || '');
  const database = getDb();
  const result = database.transaction(() => {
    database
      .prepare('INSERT INTO reports (review_id, reporter_id, reason, details, details_flagged_json, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        reviewId,
        reporterId,
        reason,
        details || null,
        detailsScan.flagged ? JSON.stringify(detailsScan.matches) : null,
        'open'
      );
    const count = openReportCount(reviewId);
    let autoHidden = false;
    if (count >= AUTO_HIDE_THRESHOLD && !review.hidden) {
      hideReview(reviewId, null, AUTO_HIDE_REASON, 'auto');
      autoHidden = true;
    }
    return { count, autoHidden, detailsFlagged: detailsScan.flagged };
  })();
  return { review, ...result };
}

function dismissReports(reviewId, actorId, note) {
  getDb()
    .prepare("UPDATE reports SET status = 'dismissed' WHERE review_id = ? AND status = 'open'")
    .run(reviewId);
  logAction({
    actorId,
    action: 'dismiss_reports',
    reviewId,
    details: note || 'Open reports dismissed.',
  });
}

function hideReview(reviewId, actorId, reason, source = 'moderator') {
  const textReason = String(reason || '').trim() || 'Hidden by a moderator.';
  getDb()
    .prepare(
      `UPDATE reviews
       SET hidden = 1, hidden_reason = ?, hidden_at = datetime('now'), hidden_by = ?, hidden_source = ?
       WHERE id = ?`
    )
    .run(textReason, actorId, source, reviewId);
  if (source === 'auto') {
    logAction({
      actorId: null,
      action: 'auto_hide',
      reviewId,
      details: textReason,
    });
  } else {
    logAction({
      actorId,
      action: 'hide_review',
      reviewId,
      details: textReason,
    });
  }
}

function restoreReview(reviewId, actorId) {
  getDb()
    .prepare(
      `UPDATE reviews
       SET hidden = 0, hidden_reason = NULL, hidden_at = NULL, hidden_by = NULL, hidden_source = NULL
       WHERE id = ?`
    )
    .run(reviewId);
  logAction({ actorId, action: 'restore_review', reviewId, details: 'Review restored to public view.' });
}

function moderatorDeleteReview(reviewId, actorId) {
  const review = getReviewById(reviewId);
  if (!review) return null;
  const property = getDb().prepare('SELECT * FROM properties WHERE id = ?').get(review.property_id);
  const snapshot = {
    address: property ? formatAddress(property) : null,
    author: review.display_name,
    excerpt: (review.review_text || '').slice(0, 400),
  };
  deleteReview(reviewId);
  logAction({
    actorId,
    action: 'delete_review',
    reviewId,
    targetUserId: review.user_id,
    details: snapshot,
  });
  return review;
}

function suspendUser(userId, actorId, reason) {
  const user = getUserById(userId);
  if (!user) return null;
  if (user.isStaff) {
    const err = new Error('Staff accounts cannot be suspended from the dashboard.');
    err.code = 'STAFF_USER';
    throw err;
  }
  const textReason = String(reason || '').trim() || 'Suspended from posting reviews.';
  getDb()
    .prepare(
      `UPDATE users SET status = 'suspended', suspended_at = datetime('now'), suspend_reason = ?, suspended_by = ?
       WHERE id = ?`
    )
    .run(textReason, actorId, userId);
  logAction({
    actorId,
    action: 'suspend_user',
    targetUserId: userId,
    details: textReason,
  });
  return getUserById(userId);
}

function unsuspendUser(userId, actorId) {
  getDb()
    .prepare(
      "UPDATE users SET status = 'active', suspended_at = NULL, suspend_reason = NULL, suspended_by = NULL WHERE id = ?"
    )
    .run(userId);
  logAction({
    actorId,
    action: 'unsuspend_user',
    targetUserId: userId,
    details: 'Account restored; user may post reviews again.',
  });
  return getUserById(userId);
}

function getModerationQueue() {
  const groups = getDb()
    .prepare(
      `SELECT r.id AS review_id,
              COUNT(*) AS open_count,
              MIN(p.created_at) AS first_reported_at,
              MAX(p.created_at) AS last_reported_at
       FROM reports p
       JOIN reviews r ON r.id = p.review_id
       WHERE p.status = 'open'
       GROUP BY r.id
       ORDER BY open_count DESC, first_reported_at ASC`
    )
    .all();
  return groups.map((group) => {
    const review = getReviewById(group.review_id);
    const property = review ? getDb().prepare('SELECT * FROM properties WHERE id = ?').get(review.property_id) : null;
    const author = review ? getUserById(review.user_id) : null;
    const reports = listReportsForReview(group.review_id).filter((r) => r.status === 'open').map((report) => {
      let detailsMatches = [];
      if (report.details_flagged_json) {
        try { detailsMatches = JSON.parse(report.details_flagged_json) || []; } catch { detailsMatches = []; }
      }
      return {
        ...report,
        detailsFlagged: detailsMatches.length > 0,
        detailsHtml: report.details ? contentFilter.highlight(report.details, detailsMatches) : '',
      };
    });
    const reasonCounts = {};
    for (const report of reports) {
      reasonCounts[report.reason] = (reasonCounts[report.reason] || 0) + 1;
    }
    return {
      ...group,
      review,
      property: property ? { ...property, address: formatAddress(property) } : null,
      author,
      reports,
      reasonCounts,
    };
  });
}

function getAuditLog({ limit = 100, offset = 0 } = {}) {
  const rows = getDb()
    .prepare(
      `SELECT a.*,
              actor.display_name AS actor_name,
              actor.email AS actor_email,
              target.display_name AS target_name,
              target.email AS target_email
       FROM moderation_actions a
       LEFT JOIN users actor ON actor.id = a.actor_id
       LEFT JOIN users target ON target.id = a.target_user_id
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset);
  return rows.map((row) => {
    let details = row.details;
    if (details && details.startsWith('{')) {
      try { details = JSON.parse(details); } catch { /* keep string */ }
    }
    return { ...row, details };
  });
}

function createVerificationRequest(data) {
  const occupancy = data.occupancyType === 'owned' ? 'owned' : 'rented';
  if (!policy.isAllowedDocument(occupancy, data.documentType)) {
    const err = new Error('Choose a document type that matches renter or owner.');
    err.code = 'INVALID_DOCUMENT';
    throw err;
  }
  const pending = getDb()
    .prepare(
      `SELECT id FROM verification_requests
       WHERE user_id = ? AND property_id = ? AND occupancy_type = ? AND status = 'pending'`
    )
    .get(data.userId, data.propertyId, occupancy);
  if (pending) {
    const err = new Error('You already have a verification request in review for this address.');
    err.code = 'PENDING_EXISTS';
    throw err;
  }
  const approved = getDb()
    .prepare(
      `SELECT id FROM verification_requests
       WHERE user_id = ? AND property_id = ? AND occupancy_type = ? AND status = 'approved'`
    )
    .get(data.userId, data.propertyId, occupancy);
  if (approved) {
    const err = new Error('This address is already verified for you.');
    err.code = 'ALREADY_VERIFIED';
    throw err;
  }
  const result = getDb()
    .prepare(
      `INSERT INTO verification_requests (
         user_id, review_id, property_id, occupancy_type, document_type,
         stored_filename, original_filename, mime_type, status,
         year_from, year_to, still_living
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    )
    .run(
      data.userId,
      data.reviewId || null,
      data.propertyId,
      occupancy,
      data.documentType,
      data.storedFilename,
      data.originalFilename || null,
      data.mimeType,
      data.yearFrom || null,
      data.yearTo || null,
      data.stillLiving ? 1 : 0
    );
  return getVerificationById(result.lastInsertRowid);
}

function getVerificationById(id) {
  const row = getDb()
    .prepare(
      `SELECT v.*,
              u.display_name, u.email,
              p.street, p.city, p.state, p.zip
       FROM verification_requests v
       JOIN users u ON u.id = v.user_id
       LEFT JOIN properties p ON p.id = v.property_id
       WHERE v.id = ?`
    )
    .get(id);
  return row ? decorateVerification(row) : null;
}

function decorateVerification(row) {
  return {
    ...row,
    still_living: Boolean(row.still_living),
    confirmed_still_living: row.confirmed_still_living == null ? null : Boolean(row.confirmed_still_living),
    address: row.street ? formatAddress(row) : null,
    documentLabel: policy.documentLabel(row.document_type),
    occupancyLabel: row.occupancy_type === 'owned' ? 'Owner' : 'Renter',
    badge: policy.verificationBadge(row.occupancy_type),
  };
}

function listPendingVerifications() {
  return getDb()
    .prepare(
      `SELECT v.*,
              u.display_name, u.email,
              p.street, p.city, p.state, p.zip
       FROM verification_requests v
       JOIN users u ON u.id = v.user_id
       LEFT JOIN properties p ON p.id = v.property_id
       WHERE v.status = 'pending'
       ORDER BY v.created_at ASC, v.id ASC`
    )
    .all()
    .map(decorateVerification);
}

function listVerificationsForUser(userId) {
  return getDb()
    .prepare(
      `SELECT v.*,
              u.display_name, u.email,
              p.street, p.city, p.state, p.zip
       FROM verification_requests v
       JOIN users u ON u.id = v.user_id
       LEFT JOIN properties p ON p.id = v.property_id
       WHERE v.user_id = ?
       ORDER BY v.created_at DESC, v.id DESC`
    )
    .all(userId)
    .map(decorateVerification);
}

function latestVerification(userId, propertyId, occupancyType) {
  const row = getDb()
    .prepare(
      `SELECT v.*,
              u.display_name, u.email,
              p.street, p.city, p.state, p.zip
       FROM verification_requests v
       JOIN users u ON u.id = v.user_id
       LEFT JOIN properties p ON p.id = v.property_id
       WHERE v.user_id = ? AND v.property_id = ? AND v.occupancy_type = ?
       ORDER BY CASE v.status WHEN 'approved' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, v.created_at DESC
       LIMIT 1`
    )
    .get(userId, propertyId, occupancyType);
  return row ? decorateVerification(row) : null;
}

function decideVerification(id, { actorId, status, rejectReason = null, yearFrom = null, yearTo = null, stillLiving = null }) {
  const request = getVerificationById(id);
  if (!request) return null;
  if (request.status !== 'pending') {
    const err = new Error('This request has already been decided.');
    err.code = 'ALREADY_DECIDED';
    throw err;
  }
  if (status !== 'approved' && status !== 'rejected') {
    throw new Error('Invalid decision.');
  }
  if (status === 'rejected' && !String(rejectReason || '').trim()) {
    const err = new Error('Please include a reason for the rejection.');
    err.code = 'REASON_REQUIRED';
    throw err;
  }
  if (request.stored_filename) uploads.deleteUpload(request.stored_filename);
  getDb()
    .prepare(
      `UPDATE verification_requests SET
         status = ?, stored_filename = NULL, reject_reason = ?,
         decided_by = ?, decided_at = datetime('now'),
         confirmed_year_from = ?, confirmed_year_to = ?, confirmed_still_living = ?
       WHERE id = ?`
    )
    .run(
      status,
      status === 'rejected' ? String(rejectReason).trim() : null,
      actorId,
      status === 'approved' ? yearFrom : null,
      status === 'approved' ? yearTo : null,
      status === 'approved' ? (stillLiving ? 1 : 0) : null,
      id
    );
  logAction({
    actorId,
    action: status === 'approved' ? 'approve_verification' : 'reject_verification',
    reviewId: request.review_id,
    targetUserId: request.user_id,
    verificationId: id,
    details:
      status === 'approved'
        ? { address: request.address, occupancy: request.occupancy_type, documentType: request.document_type }
        : { address: request.address, occupancy: request.occupancy_type, reason: String(rejectReason).trim() },
  });
  return getVerificationById(id);
}

function ensureAdminAccount(database) {
  const adminEmail = 'admin@livedhere.example';
  const credPath = path.join(DATA_DIR, 'admin-credentials.txt');
  const existing = database.prepare('SELECT * FROM users WHERE email = ?').get(adminEmail);
  const envPassword = (process.env.ADMIN_PASSWORD || '').trim();
  if (existing) {
    if (existing.role !== 'admin') {
      database.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(existing.id);
    }
    if (envPassword) {
      database
        .prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        .run(bcrypt.hashSync(envPassword, BCRYPT_ROUNDS), existing.id);
    }
    return;
  }
  if (!envPassword && process.env.NODE_ENV === 'production') {
    throw new Error('ADMIN_PASSWORD must be set to create the admin account in production');
  }
  const crypto = require('crypto');
  const password = envPassword || crypto.randomBytes(18).toString('base64url');
  database
    .prepare(
      'INSERT INTO users (email, password_hash, display_name, is_demo, role, status) VALUES (?, ?, ?, 0, ?, ?)'
    )
    .run(adminEmail, bcrypt.hashSync(password, BCRYPT_ROUNDS), 'Caleb', 'admin', 'active');
  if (envPassword) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    credPath,
    [
      'LivedHere admin account',
      `email: ${adminEmail}`,
      `password: ${password}`,
      'role: admin',
      `created: ${new Date().toISOString()}`,
      '',
    ].join('\n'),
    { mode: 0o600 }
  );
  try { fs.chmodSync(credPath, 0o600); } catch { /* ignore */ }
}

function ensureDemoAccounts(database) {
  const existing = database.prepare('SELECT * FROM users WHERE email = ?').get(MOD_EMAIL);
  if (!existing) {
    database
      .prepare(
        'INSERT INTO users (email, password_hash, display_name, is_demo, role, status) VALUES (?, ?, ?, 1, ?, ?)'
      )
      .run(MOD_EMAIL, bcrypt.hashSync(MOD_PASSWORD, BCRYPT_ROUNDS), MOD_NAME, 'moderator', 'active');
  } else if (existing.role !== 'moderator' && existing.role !== 'admin') {
    database.prepare("UPDATE users SET role = 'moderator', is_demo = 1 WHERE id = ?").run(existing.id);
  }
}

function cleanupStrayTestData(database) {
  const properties = database
    .prepare(
      `SELECT id, street FROM properties
       WHERE street LIKE '%Test Curl%' OR street_norm LIKE '%test curl%'
          OR street LIKE '%Auto Hide%' OR street LIKE '%Verify Curl%'
          OR street LIKE '%Should Fail%'`
    )
    .all();
  for (const property of properties) {
    const files = database
      .prepare('SELECT stored_filename FROM verification_requests WHERE property_id = ? AND stored_filename IS NOT NULL')
      .all(property.id);
    for (const file of files) uploads.deleteUpload(file.stored_filename);
    database.prepare('DELETE FROM properties WHERE id = ?').run(property.id);
  }
  const testers = database
    .prepare("SELECT id FROM users WHERE email IN ('curl.tester@example.com') OR email LIKE 'report-test-%@example.com' OR email LIKE 'verify-test-%@example.com'")
    .all();
  for (const user of testers) {
    const files = database
      .prepare('SELECT stored_filename FROM verification_requests WHERE user_id = ? AND stored_filename IS NOT NULL')
      .all(user.id);
    for (const file of files) uploads.deleteUpload(file.stored_filename);
    database.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  }
}

function ensureDemoModerationFixtures(database) {
  const openCount = database.prepare("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'").get().n;
  if (openCount === 0) {
    const placeholder = database
      .prepare(
        `SELECT r.id FROM reviews r
         JOIN properties p ON p.id = r.property_id
         WHERE p.street = '12 Placeholder Rd'
         ORDER BY r.id LIMIT 1`
      )
      .get();
    const demo = database.prepare('SELECT id FROM users WHERE email = ?').get(DEMO_EMAIL);
    const jordan = database.prepare('SELECT id FROM users WHERE email = ?').get('jordan@example.test');
    if (placeholder && demo && jordan) {
      const insert = database.prepare(
        "INSERT OR IGNORE INTO reports (review_id, reporter_id, reason, details, status, created_at) VALUES (?, ?, ?, ?, 'open', ?)"
      );
      insert.run(
        placeholder.id,
        demo.id,
        'not_resident',
        'Demo report: this sample review is useful for trying the moderation queue.',
        '2026-11-10 09:00:00'
      );
      insert.run(
        placeholder.id,
        jordan.id,
        'false_misleading',
        'Demo report: second sample report so the queue shows more than one reason.',
        '2026-11-11 11:30:00'
      );
    }
  }

  const pending = database.prepare("SELECT COUNT(*) AS n FROM verification_requests WHERE status = 'pending'").get().n;
  if (pending === 0) {
    const demoReview = database
      .prepare(
        `SELECT r.id, r.user_id, r.property_id, r.occupancy_type, r.year_from, r.year_to, r.still_living
         FROM reviews r
         JOIN users u ON u.id = r.user_id
         JOIN properties p ON p.id = r.property_id
         WHERE u.email = ? AND p.street = '123 Example St' AND r.occupancy_type = 'rented'
         ORDER BY r.id LIMIT 1`
      )
      .get(DEMO_EMAIL);
    if (demoReview) {
      uploads.ensureUploadDir();
      const pdf = uploads.writeMinimalPdf([
        'SAMPLE DOCUMENT — not a real lease',
        'LivedHere demo verification upload',
        'Resident: Demo Resident',
        'Address: 123 Example St, Unit 2B, Springfield, IL 62701',
        'Lease dates: 2022-2025',
        'Account numbers redacted for the demo.',
      ]);
      const saved = uploads.saveVerificationFile(pdf);
      database
        .prepare(
          `INSERT INTO verification_requests (
             user_id, review_id, property_id, occupancy_type, document_type,
             stored_filename, original_filename, mime_type, status,
             year_from, year_to, still_living, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
        )
        .run(
          demoReview.user_id,
          demoReview.id,
          demoReview.property_id,
          'rented',
          'lease',
          saved.filename,
          'sample-lease.pdf',
          saved.mime,
          demoReview.year_from,
          demoReview.year_to,
          demoReview.still_living || 0,
          '2026-11-14 16:00:00'
        );
    }
  }

  const awaiting = database.prepare("SELECT COUNT(*) AS n FROM reviews WHERE moderation_status = 'pending'").get().n;
  if (awaiting === 0) {
    const sam = database.prepare('SELECT id FROM users WHERE email = ?').get('sam@example.test');
    const property = database.prepare("SELECT * FROM properties WHERE street = '100 Fiction Blvd'").get();
    if (sam && property) {
      const text = 'Sample review for the approval queue: the building manager was an asshole about repairs and told us to go f*ck ourselves. This is fictional demo content.';
      const scan = contentFilter.scanReview({ reviewText: text, pros: '', cons: 'Rude management.' });
      database
        .prepare(
          `INSERT INTO reviews (
             property_id, user_id, occupancy_type, year_from, year_to, still_living,
             review_text, pros, cons, would_recommend, ratings_json, anonymous, is_sample,
             moderation_status, flagged_json, created_at
           ) VALUES (?, ?, 'rented', 2024, 2025, 0, ?, ?, ?, 0, '{}', 1, 1, 'pending', ?, ?)`
        )
        .run(
          property.id,
          sam.id,
          text,
          '',
          'Rude management.',
          JSON.stringify(scan.matches),
          '2026-11-14 18:00:00'
        );
    }
  }
}

function getApprovalQueue() {
  const rows = getDb()
    .prepare(
      `SELECT r.id
       FROM reviews r
       WHERE r.moderation_status = 'pending'
       ORDER BY r.created_at ASC, r.id ASC`
    )
    .all();
  return rows.map((row) => {
    const review = getReviewById(row.id);
    const property = review ? getDb().prepare('SELECT * FROM properties WHERE id = ?').get(review.property_id) : null;
    const author = review ? getUserById(review.user_id) : null;
    const highlighted = {
      review_text: contentFilter.highlight(review.review_text || '', review.flaggedMatches, 'review_text'),
      pros: contentFilter.highlight(review.pros || '', review.flaggedMatches, 'pros'),
      cons: contentFilter.highlight(review.cons || '', review.flaggedMatches, 'cons'),
    };
    return {
      review,
      author,
      property: property ? { ...property, address: formatAddress(property) } : null,
      highlighted,
      flaggedWords: [...new Set((review.flaggedMatches || []).map((m) => m.word))],
    };
  });
}

function approveReview(reviewId, actorId) {
  const review = getReviewById(reviewId);
  if (!review) return null;
  getDb()
    .prepare(
      `UPDATE reviews
       SET moderation_status = 'published', rejected_reason = NULL,
           moderation_decided_at = datetime('now'), moderation_decided_by = ?
       WHERE id = ?`
    )
    .run(actorId, reviewId);
  logAction({
    actorId,
    action: 'approve_review',
    reviewId,
    targetUserId: review.user_id,
    details: 'Approved for public publication after content review.',
  });
  return getReviewById(reviewId);
}

function rejectReview(reviewId, actorId, reason) {
  const review = getReviewById(reviewId);
  if (!review) return null;
  const text = String(reason || '').trim();
  if (!text) {
    const err = new Error('Please include a reason the author will see.');
    err.code = 'REASON_REQUIRED';
    throw err;
  }
  getDb()
    .prepare(
      `UPDATE reviews
       SET moderation_status = 'rejected', rejected_reason = ?,
           moderation_decided_at = datetime('now'), moderation_decided_by = ?
       WHERE id = ?`
    )
    .run(text, actorId, reviewId);
  logAction({
    actorId,
    action: 'reject_review',
    reviewId,
    targetUserId: review.user_id,
    details: text,
  });
  return getReviewById(reviewId);
}

function pendingApprovalCount() {
  return getDb().prepare("SELECT COUNT(*) AS n FROM reviews WHERE moderation_status = 'pending'").get().n;
}

function resetAndSeed() {

  if (db) {
    db.close();
    db = null;
  }
  for (const file of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
  getDb();
  console.log(`Seeded database at ${DB_PATH}`);
  console.log(`Demo account: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`Moderator account: ${MOD_EMAIL} / ${MOD_PASSWORD}`);
}

module.exports = {
  getDb,
  DEMO_EMAIL,
  DEMO_PASSWORD,
  DEMO_NAME,
  MOD_EMAIL,
  MOD_PASSWORD,
  MOD_NAME,
  normalizeStreet,
  normalizeCity,
  normalizeState,
  normalizeZip,
  formatAddress,
  createUser,
  getUserById,
  getUserByEmail,
  authenticate,
  emailTaken,
  findProperty,
  createProperty,
  findOrCreateProperty,
  getPropertyById,
  getReviewById,
  insertReview,
  updateReview,
  deleteReview,
  searchProperties,
  featuredProperties,
  recentReviews,
  reviewsByUser,
  siteStats,
  resetAndSeed,
  parseRatings,
  logAction,
  openReportCount,
  getReportForUser,
  listReportsForReview,
  createReport,
  dismissReports,
  hideReview,
  restoreReview,
  moderatorDeleteReview,
  suspendUser,
  unsuspendUser,
  getModerationQueue,
  getAuditLog,
  createVerificationRequest,
  getVerificationById,
  listPendingVerifications,
  listVerificationsForUser,
  latestVerification,
  decideVerification,
  cleanupStrayTestData,
  updateDisplayName,
  presentReview,
  presentProperty,
  isPubliclyListed,
  getApprovalQueue,
  approveReview,
  rejectReview,
  pendingApprovalCount,
  ADMIN_EMAIL: 'admin@livedhere.example',
  ADMIN_CREDENTIALS_PATH: path.join(DATA_DIR, 'admin-credentials.txt'),
};
