'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const db = require('./db');
const { RATING_GROUPS, CATEGORY_BY_ID, parseRatings } = require('./ratings');
const SqliteSessionStore = require('./session-store');
const policy = require('./policy');
const uploads = require('./uploads');
const contentFilter = require('./content-filter');

const PORT = Number(process.env.PORT) || 3000;
function loadSessionSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim()) {
    return process.env.SESSION_SECRET.trim();
  }
  const secretPath = path.join(__dirname, 'data', 'session-secret.txt');
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  if (fs.existsSync(secretPath)) {
    const existing = fs.readFileSync(secretPath, 'utf8').trim();
    if (existing) return existing;
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretPath, `${secret}\n`, { mode: 0o600 });
  try { fs.chmodSync(secretPath, 0o600); } catch { /* ignore */ }
  return secret;
}

const SESSION_SECRET = loadSessionSecret();

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = Array.from({ length: CURRENT_YEAR - 1969 }, (_, i) => CURRENT_YEAR - i);

const US_STATES = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'],
  ['CA', 'California'], ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'],
  ['DC', 'District of Columbia'], ['FL', 'Florida'], ['GA', 'Georgia'], ['HI', 'Hawaii'],
  ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'],
  ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'],
  ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'],
  ['MS', 'Mississippi'], ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'],
  ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'], ['NM', 'New Mexico'],
  ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'],
  ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'], ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'],
  ['UT', 'Utah'], ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'],
  ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
];

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use((req, res, next) => {
  if (!req.body || typeof req.body !== 'object') req.body = {};
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    name: 'livedhere.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: new SqliteSessionStore(db.getDb()),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

app.use((req, res, next) => {
  res.locals.appName = 'LivedHere';
  res.locals.currentUser = null;
  res.locals.currentYear = CURRENT_YEAR;
  res.locals.RATING_GROUPS = RATING_GROUPS;
  res.locals.CATEGORY_BY_ID = CATEGORY_BY_ID;
  res.locals.formatAddress = db.formatAddress;
  res.locals.formatYears = formatYears;
  res.locals.starPercent = starPercent;
  res.locals.policy = policy;
  res.locals.reasonLabel = policy.reasonLabel;
  res.locals.contentFilter = contentFilter;
  res.locals.highlight = contentFilter.highlight;
  if (req.session.userId) {
    res.locals.currentUser = db.getUserById(req.session.userId);
    if (!res.locals.currentUser) delete req.session.userId;
  }
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrfToken;
  next();
});

function verifyCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = (req.body && req.body._csrf) || req.get('x-csrf-token') || (req.query && req.query._csrf);
  if (!req.session.csrfToken || !token || token !== req.session.csrfToken) {
    return res.status(403).render('403', { title: 'Access denied', message: 'Your form expired or the CSRF check failed. Please go back and try again.' });
  }
  next();
}

app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.is('multipart/form-data')) return next();
  return verifyCsrf(req, res, next);
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many attempts. Please wait a few minutes and try again.',
});
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests. Please wait a few minutes and try again.',
});

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

function safeNext(value, fallback = '/') {
  if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\')) {
    return value;
  }
  return fallback;
}

function requireAuth(req, res, next) {
  if (req.session.userId && res.locals.currentUser) return next();
  const nextUrl = req.method === 'GET' ? req.originalUrl : '/review';
  setFlash(req, 'info', 'Log in or create an account to continue.');
  return res.redirect('/login?next=' + encodeURIComponent(nextUrl));
}

function requireCanPost(req, res, next) {
  requireAuth(req, res, () => {
    if (policy.isSuspended(res.locals.currentUser)) {
      setFlash(
        req,
        'error',
        res.locals.currentUser.suspend_reason
          ? `Your account is suspended from posting reviews. ${res.locals.currentUser.suspend_reason}`
          : 'Your account is suspended from posting reviews.'
      );
      return res.redirect('/account');
    }
    next();
  });
}

function requireModerator(req, res, next) {
  if (!res.locals.currentUser) {
    setFlash(req, 'info', 'Log in with a moderator account to continue.');
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  if (!policy.isStaff(res.locals.currentUser)) {
    return res.status(403).render('403', { title: 'Access denied' });
  }
  next();
}

const uploadDocument = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploads.MAX_BYTES, files: 1 },
}).single('document');

function handleUpload(req, res, next) {
  uploadDocument(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        setFlash(req, 'error', 'File must be 10 MB or smaller.');
        return res.redirect((req.body && req.body.next) || req.get('referer') || '/account');
      }
      return next(err);
    }
    return verifyCsrf(req, res, next);
  });
}

function formatYears(review) {
  if (!review) return '';
  const from = review.year_from;
  if (review.still_living) return from ? `${from}–present` : 'Currently lives here';
  if (from && review.year_to) return from === review.year_to ? String(from) : `${from}–${review.year_to}`;
  if (from) return `From ${from}`;
  if (review.year_to) return `Until ${review.year_to}`;
  return '';
}

function starPercent(value) {
  if (value == null || Number.isNaN(Number(value))) return 0;
  return Math.max(0, Math.min(100, (Number(value) / 5) * 100));
}

function parseOptionalYear(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1900 || n > CURRENT_YEAR + 1) return null;
  return n;
}

function parseWouldRecommend(value) {
  if (value === 'yes' || value === '1') return 1;
  if (value === 'no' || value === '0') return 0;
  return null;
}

function cleanText(value, max) {
  if (value == null) return '';
  return String(value).trim().slice(0, max);
}

function collectReviewInput(body) {
  const errors = [];
  const street = cleanText(body.street, 120);
  const city = cleanText(body.city, 80);
  const state = db.normalizeState(cleanText(body.state, 20));
  const zip = db.normalizeZip(body.zip) || cleanText(body.zip, 10);
  const unit = cleanText(body.unit, 20);
  const occupancyType = body.occupancy_type === 'owned' ? 'owned' : body.occupancy_type === 'rented' ? 'rented' : '';

  if (!street) errors.push('Street address is required.');
  if (!city) errors.push('City is required.');
  if (!state) errors.push('State is required.');
  if (!zip) errors.push('ZIP code is required.');
  if (!occupancyType) errors.push('Please say whether you rented or owned the home.');

  const yearFrom = parseOptionalYear(body.year_from);
  const stillLiving = body.still_living === '1' || body.still_living === 'on';
  const yearTo = stillLiving ? null : parseOptionalYear(body.year_to);
  if (yearFrom && yearTo && yearTo < yearFrom) {
    errors.push('The end year cannot be before the start year.');
  }

  const ratings = parseRatings(body.ratings || extractRatings(body));

  return {
    errors,
    address: { street, city, state, zip },
    values: {
      street,
      city,
      state,
      zip,
      unit,
      occupancyType,
      yearFrom,
      yearTo,
      stillLiving,
      reviewText: cleanText(body.review_text, 8000),
      pros: cleanText(body.pros, 1000),
      cons: cleanText(body.cons, 1000),
      wouldRecommend: parseWouldRecommend(body.would_recommend),
      ratings,
      anonymous: body.anonymous === '1' || body.anonymous === 'on',
    },
  };
}

function extractRatings(body) {
  const ratings = {};
  if (!body || typeof body !== 'object') return ratings;
  for (const [key, value] of Object.entries(body)) {
    if (key.startsWith('rating_')) ratings[key.slice(7)] = value;
  }
  return ratings;
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    const flash = req.session.flash;
    req.session.regenerate((err) => {
      if (err) return reject(err);
      if (flash) req.session.flash = flash;
      resolve();
    });
  });
}

app.get('/', (req, res) => {
  res.render('home', {
    title: 'Reviews from people who actually lived there',
    stats: db.siteStats(),
    featured: db.featuredProperties(4).map((property) => db.presentProperty(property)),
    recent: db.recentReviews(6).map((review) => db.presentReview(review)),
    query: '',
  });
});

app.get('/search', (req, res) => {
  const query = String(req.query.q || '').trim();
  const results = query ? db.searchProperties(query) : [];
  res.render('search', {
    title: query ? `Search: ${query}` : 'Search homes',
    query,
    results: results.map((property) => db.presentProperty(property)),
  });
});

app.get('/properties/:id', (req, res, next) => {
  const occupancy = req.query.occupancy === 'rented' || req.query.occupancy === 'owned' ? req.query.occupancy : null;
  const verifiedOnly = req.query.verified === '1';
  const viewerId = res.locals.currentUser ? res.locals.currentUser.id : null;
  const property = db.getPropertyById(req.params.id, { occupancy, verifiedOnly, viewerId });
  if (!property) return next();
  const reportedIds = new Set();
  if (viewerId) {
    for (const review of property.reviews) {
      if (db.getReportForUser(review.id, viewerId)) reportedIds.add(review.id);
    }
  }
  res.render('property', {
    title: property.address,
    property: db.presentProperty(property, { viewerId }),
    occupancy,
    verifiedOnly,
    reportedIds,
  });
});

app.get('/review', requireCanPost, (req, res) => {
  let prefill = blankForm();
  if (req.query.property_id) {
    const property = db.getPropertyById(req.query.property_id);
    if (property) {
      prefill = {
        ...prefill,
        street: property.street,
        city: property.city,
        state: property.state,
        zip: property.zip,
      };
    }
  }
  res.render('review-form', {
    title: 'Write a review',
    mode: 'create',
    review: null,
    values: prefill,
    errors: [],
    states: US_STATES,
    yearOptions: YEAR_OPTIONS,
  });
});

app.post('/review', writeLimiter, requireCanPost, async (req, res) => {
  const { errors, address, values } = collectReviewInput(req.body);
  if (errors.length) {
    return res.status(400).render('review-form', {
      title: 'Write a review',
      mode: 'create',
      review: null,
      values,
      errors,
      states: US_STATES,
      yearOptions: YEAR_OPTIONS,
    });
  }
  const property = db.findOrCreateProperty(address);
  const review = db.insertReview({
    propertyId: property.id,
    userId: req.session.userId,
    occupancyType: values.occupancyType,
    unit: values.unit,
    yearFrom: values.yearFrom,
    yearTo: values.yearTo,
    stillLiving: values.stillLiving,
    reviewText: values.reviewText,
    pros: values.pros,
    cons: values.cons,
    wouldRecommend: values.wouldRecommend,
    ratings: values.ratings,
    anonymous: values.anonymous,
    isSample: false,
  });
  setFlash(
    req,
    'success',
    review.isPending
      ? 'Your review was saved and is awaiting approval before it appears publicly.'
      : 'Your review is up. Thank you for sharing it.'
  );
  await saveSession(req);
  res.redirect(`/properties/${property.id}#review-${review.id}`);
});

app.get('/reviews/:id/edit', requireCanPost, (req, res, next) => {
  const review = db.getReviewById(req.params.id);
  if (!review) return next();
  if (review.user_id !== req.session.userId) {
    setFlash(req, 'error', 'You can only edit your own reviews.');
    return res.redirect(`/properties/${review.property_id}`);
  }
  const property = db.getPropertyById(review.property_id);
  res.render('review-form', {
    title: 'Edit your review',
    mode: 'edit',
    review,
    values: valuesFromReview(review, property),
    errors: [],
    states: US_STATES,
    yearOptions: YEAR_OPTIONS,
  });
});

app.post('/reviews/:id', writeLimiter, requireCanPost, async (req, res, next) => {
  const review = db.getReviewById(req.params.id);
  if (!review) return next();
  if (review.user_id !== req.session.userId) {
    setFlash(req, 'error', 'You can only edit your own reviews.');
    return res.redirect(`/properties/${review.property_id}`);
  }
  const { errors, address, values } = collectReviewInput(req.body);
  if (errors.length) {
    return res.status(400).render('review-form', {
      title: 'Edit your review',
      mode: 'edit',
      review,
      values,
      errors,
      states: US_STATES,
      yearOptions: YEAR_OPTIONS,
    });
  }
  const property = db.findOrCreateProperty(address);
  const oldPropertyId = review.property_id;
  const updated = db.updateReview(review.id, {
    propertyId: property.id,
    occupancyType: values.occupancyType,
    unit: values.unit,
    yearFrom: values.yearFrom,
    yearTo: values.yearTo,
    stillLiving: values.stillLiving,
    reviewText: values.reviewText,
    pros: values.pros,
    cons: values.cons,
    wouldRecommend: values.wouldRecommend,
    ratings: values.ratings,
    anonymous: values.anonymous,
  });
  if (oldPropertyId !== property.id) {
    const left = db.getDb().prepare('SELECT COUNT(*) AS n FROM reviews WHERE property_id = ?').get(oldPropertyId).n;
    if (left === 0) db.getDb().prepare('DELETE FROM properties WHERE id = ?').run(oldPropertyId);
  }
  setFlash(
    req,
    'success',
    updated && updated.isPending
      ? 'Your changes were saved and the review is awaiting approval before it appears publicly.'
      : 'Your review has been updated.'
  );
  await saveSession(req);
  res.redirect(`/properties/${property.id}#review-${review.id}`);
});

app.post('/reviews/:id/delete', requireAuth, async (req, res, next) => {
  const review = db.getReviewById(req.params.id);
  if (!review) return next();
  if (review.user_id !== req.session.userId) {
    setFlash(req, 'error', 'You can only delete your own reviews.');
    return res.redirect(`/properties/${review.property_id}`);
  }
  const propertyId = review.property_id;
  db.deleteReview(review.id);
  const stillThere = db.getPropertyById(propertyId);
  setFlash(req, 'success', 'Your review has been deleted.');
  await saveSession(req);
  res.redirect(stillThere ? `/properties/${propertyId}` : '/');
});

app.get('/signup', (req, res) => {
  if (res.locals.currentUser) return res.redirect(safeNext(req.query.next, '/account'));
  res.render('signup', {
    title: 'Create an account',
    values: { email: '', displayName: '' },
    errors: [],
    next: safeNext(req.query.next, '/'),
  });
});

app.post('/signup', authLimiter, async (req, res) => {
  if (req.session.userId) return res.redirect(safeNext(req.body.next, '/account'));
  const email = cleanText(req.body.email, 120).toLowerCase();
  const displayName = cleanText(req.body.display_name, 40);
  const password = String(req.body.password || '');
  const nextUrl = safeNext(req.body.next, '/');
  const errors = [];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Enter a valid email address.');
  if (displayName.length < 2) errors.push('Display name should be at least 2 characters.');
  if (displayName && contentFilter.scan(displayName).flagged) {
    errors.push('Please choose a different display name. That one isn’t allowed.');
  }
  if (password.length < 8) errors.push('Password should be at least 8 characters.');
  if (!errors.length && db.emailTaken(email)) errors.push('An account with that email already exists. Try logging in.');
  if (errors.length) {
    return res.status(400).render('signup', {
      title: 'Create an account',
      values: { email, displayName },
      errors,
      next: nextUrl,
    });
  }
  const user = db.createUser({ email, password, displayName });
  await regenerateSession(req);
  req.session.userId = user.id;
  setFlash(req, 'success', `Welcome to LivedHere, ${user.display_name}.`);
  await saveSession(req);
  res.redirect(nextUrl);
});

app.get('/login', (req, res) => {
  if (res.locals.currentUser) return res.redirect(safeNext(req.query.next, '/account'));
  res.render('login', {
    title: 'Log in',
    values: { email: '' },
    errors: [],
    next: safeNext(req.query.next, '/'),
  });
});

app.post('/login', authLimiter, async (req, res) => {
  const email = cleanText(req.body.email, 120);
  const password = String(req.body.password || '');
  const nextUrl = safeNext(req.body.next, '/');
  const user = await db.authenticate(email, password);
  if (!user) {
    return res.status(401).render('login', {
      title: 'Log in',
      values: { email },
      errors: ['Email or password is incorrect.'],
      next: nextUrl,
    });
  }
  await regenerateSession(req);
  req.session.userId = user.id;
  setFlash(req, 'success', `Welcome back, ${user.display_name}.`);
  await saveSession(req);
  res.redirect(nextUrl);
});

app.post('/logout', async (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('livedhere.sid');
    res.redirect('/');
  });
});

app.get('/account', requireAuth, (req, res) => {
  const reviews = db.reviewsByUser(req.session.userId).map((review) => ({
    ...review,
    verificationRequest: db.latestVerification(review.user_id, review.property_id, review.occupancy_type),
  }));
  res.render('account', {
    title: 'Your account',
    reviews,
    verifications: db.listVerificationsForUser(req.session.userId),
    nameErrors: [],
    displayNameValue: res.locals.currentUser.display_name,
  });
});

app.post('/account/display-name', requireAuth, async (req, res) => {
  const displayName = cleanText(req.body.display_name, 40);
  const errors = [];
  if (displayName.length < 2) errors.push('Display name should be at least 2 characters.');
  if (displayName && contentFilter.scan(displayName).flagged) {
    errors.push('Please choose a different display name. That one isn’t allowed.');
  }
  const reviews = db.reviewsByUser(req.session.userId).map((review) => ({
    ...review,
    verificationRequest: db.latestVerification(review.user_id, review.property_id, review.occupancy_type),
  }));
  if (errors.length) {
    return res.status(400).render('account', {
      title: 'Your account',
      reviews,
      verifications: db.listVerificationsForUser(req.session.userId),
      nameErrors: errors,
      displayNameValue: displayName,
    });
  }
  const user = db.updateDisplayName(req.session.userId, displayName);
  res.locals.currentUser = user;
  setFlash(req, 'success', 'Your display name has been updated.');
  await saveSession(req);
  res.redirect('/account');
});

app.get('/about', (req, res) => {
  res.render('about', { title: 'About LivedHere' });
});

app.get('/reviews/:id/report', requireAuth, (req, res, next) => {
  const review = db.getReviewById(req.params.id);
  if (!review) return next();
  const property = db.getDb().prepare('SELECT * FROM properties WHERE id = ?').get(review.property_id);
  res.render('report', {
    title: 'Report a review',
    review,
    property: { ...property, address: db.formatAddress(property) },
    errors: [],
    values: { reason: '', details: '' },
  });
});

app.post('/reviews/:id/report', writeLimiter, requireAuth, async (req, res, next) => {
  const review = db.getReviewById(req.params.id);
  if (!review) return next();
  const property = db.getDb().prepare('SELECT * FROM properties WHERE id = ?').get(review.property_id);
  const reason = cleanText(req.body.reason, 40);
  const details = cleanText(req.body.details, 1000);
  try {
    const result = db.createReport({
      reviewId: review.id,
      reporterId: req.session.userId,
      reason,
      details,
    });
    setFlash(
      req,
      'success',
      result.autoHidden
        ? 'Thanks for the report. This review was hidden pending moderation after receiving multiple reports.'
        : 'Thanks for the report. A moderator will review it from the dashboard.'
    );
    await saveSession(req);
    return res.redirect(`/properties/${review.property_id}#review-${review.id}`);
  } catch (err) {
    const status = err.code === 'OWN_REVIEW' || err.code === 'ALREADY_REPORTED' || err.code === 'INVALID_REASON' ? 400 : 400;
    if (req.accepts('html')) {
      return res.status(status).render('report', {
        title: 'Report a review',
        review,
        property: { ...property, address: db.formatAddress(property) },
        errors: [err.message],
        values: { reason, details },
      });
    }
    return res.status(status).send(err.message);
  }
});

app.get('/reviews/:id/verify', requireAuth, (req, res, next) => {
  const review = db.getReviewById(req.params.id);
  if (!review) return next();
  if (review.user_id !== req.session.userId) {
    setFlash(req, 'error', 'You can only request verification for your own reviews.');
    return res.redirect(`/properties/${review.property_id}`);
  }
  const property = db.getDb().prepare('SELECT * FROM properties WHERE id = ?').get(review.property_id);
  const existing = db.latestVerification(review.user_id, review.property_id, review.occupancy_type);
  res.render('verify-form', {
    title: 'Request verification',
    review,
    property: { ...property, address: db.formatAddress(property) },
    existing,
    errors: [],
    values: {
      occupancyType: review.occupancy_type,
      documentType: '',
      yearFrom: review.year_from,
      yearTo: review.year_to,
      stillLiving: review.still_living,
    },
    yearOptions: YEAR_OPTIONS,
  });
});

app.post('/reviews/:id/verify', writeLimiter, requireAuth, handleUpload, async (req, res, next) => {
  const review = db.getReviewById(req.params.id);
  if (!review) return next();
  if (review.user_id !== req.session.userId) {
    setFlash(req, 'error', 'You can only request verification for your own reviews.');
    return res.redirect(`/properties/${review.property_id}`);
  }
  const property = db.getDb().prepare('SELECT * FROM properties WHERE id = ?').get(review.property_id);
  const occupancyType = req.body.occupancy_type === 'owned' ? 'owned' : 'rented';
  const rawDoc = req.body.document_type;
  const documentType = cleanText(Array.isArray(rawDoc) ? rawDoc.filter(Boolean).pop() : rawDoc, 40);
  const yearFrom = parseOptionalYear(req.body.year_from);
  const stillLiving = req.body.still_living === '1' || req.body.still_living === 'on';
  const yearTo = stillLiving ? null : parseOptionalYear(req.body.year_to);
  const values = { occupancyType, documentType, yearFrom, yearTo, stillLiving };
  const renderError = (errors, status = 400) =>
    res.status(status).render('verify-form', {
      title: 'Request verification',
      review,
      property: { ...property, address: db.formatAddress(property) },
      existing: db.latestVerification(review.user_id, review.property_id, occupancyType),
      errors,
      values,
      yearOptions: YEAR_OPTIONS,
    });

  if (!req.file || !req.file.buffer) {
    return renderError(['Please upload a PDF, JPG, or PNG document (10 MB or smaller).']);
  }
  let saved;
  try {
    saved = uploads.saveVerificationFile(req.file.buffer);
  } catch (err) {
    return renderError([err.message]);
  }
  try {
    db.createVerificationRequest({
      userId: req.session.userId,
      reviewId: review.id,
      propertyId: review.property_id,
      occupancyType,
      documentType,
      storedFilename: saved.filename,
      originalFilename: cleanText(req.file.originalname, 200),
      mimeType: saved.mime,
      yearFrom,
      yearTo,
      stillLiving,
    });
  } catch (err) {
    uploads.deleteUpload(saved.filename);
    return renderError([err.message]);
  }
  setFlash(
    req,
    'success',
    'Your verification request is in the queue. There are no email notifications — check Your account or wait for a moderator to decide.'
  );
  await saveSession(req);
  res.redirect('/account');
});

app.get('/moderation', requireModerator, (req, res) => {
  res.render('moderation-queue', {
    title: 'Moderation queue',
    queue: db.getModerationQueue(),
    pendingVerifications: db.listPendingVerifications().length,
    pendingApprovals: db.pendingApprovalCount(),
    tab: 'reports',
  });
});

app.get('/moderation/verification', requireModerator, (req, res) => {
  res.render('moderation-verification', {
    title: 'Verification requests',
    requests: db.listPendingVerifications(),
    pendingVerifications: db.listPendingVerifications().length,
    pendingApprovals: db.pendingApprovalCount(),
    tab: 'verification',
    yearOptions: YEAR_OPTIONS,
  });
});

app.get('/moderation/log', requireModerator, (req, res) => {
  res.render('moderation-log', {
    title: 'Moderation audit log',
    entries: db.getAuditLog({ limit: 200 }),
    pendingVerifications: db.listPendingVerifications().length,
    pendingApprovals: db.pendingApprovalCount(),
    tab: 'log',
  });
});

app.get('/moderation/approval', requireModerator, (req, res) => {
  res.render('moderation-approval', {
    title: 'Awaiting approval',
    queue: db.getApprovalQueue(),
    pendingVerifications: db.listPendingVerifications().length,
    pendingApprovals: db.pendingApprovalCount(),
    tab: 'approval',
  });
});

app.post('/moderation/reviews/:id/approve', requireModerator, async (req, res, next) => {
  const review = db.approveReview(req.params.id, req.session.userId);
  if (!review) return next();
  setFlash(req, 'success', 'The review is now published.');
  await saveSession(req);
  res.redirect('/moderation/approval');
});

app.post('/moderation/reviews/:id/reject', requireModerator, async (req, res, next) => {
  try {
    const review = db.rejectReview(req.params.id, req.session.userId, cleanText(req.body.reason, 500));
    if (!review) return next();
    setFlash(req, 'success', 'The review was rejected. The author will see your reason.');
  } catch (err) {
    setFlash(req, 'error', err.message);
  }
  await saveSession(req);
  res.redirect('/moderation/approval');
});

app.get('/moderation/verifications/:id/file', requireModerator, (req, res, next) => {

  const request = db.getVerificationById(req.params.id);
  if (!request || !request.stored_filename) return next();
  const filePath = uploads.resolveUpload(request.stored_filename);
  if (!filePath) return next();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', request.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${(request.original_filename || request.stored_filename).replace(/"/g, '')}"`);
  res.sendFile(filePath);
});

app.post('/moderation/reviews/:id/dismiss', requireModerator, async (req, res, next) => {
  if (!db.getReviewById(req.params.id)) return next();
  db.dismissReports(req.params.id, req.session.userId, cleanText(req.body.note, 500) || 'Open reports dismissed.');
  setFlash(req, 'success', 'Reports dismissed.');
  await saveSession(req);
  res.redirect('/moderation');
});

app.post('/moderation/reviews/:id/hide', requireModerator, async (req, res, next) => {
  if (!db.getReviewById(req.params.id)) return next();
  const reason = cleanText(req.body.reason, 500);
  if (!reason) {
    setFlash(req, 'error', 'Please include a reason the author will see.');
    await saveSession(req);
    return res.redirect('/moderation');
  }
  db.hideReview(req.params.id, req.session.userId, reason, 'moderator');
  setFlash(req, 'success', 'The review is hidden from public pages.');
  await saveSession(req);
  res.redirect('/moderation');
});

app.post('/moderation/reviews/:id/restore', requireModerator, async (req, res, next) => {
  if (!db.getReviewById(req.params.id)) return next();
  db.restoreReview(req.params.id, req.session.userId);
  setFlash(req, 'success', 'The review is visible again.');
  await saveSession(req);
  res.redirect('/moderation');
});

app.post('/moderation/reviews/:id/delete', requireModerator, async (req, res, next) => {
  const review = db.getReviewById(req.params.id);
  if (!review) return next();
  db.moderatorDeleteReview(review.id, req.session.userId);
  setFlash(req, 'success', 'The review was deleted.');
  await saveSession(req);
  res.redirect('/moderation');
});

app.post('/moderation/users/:id/suspend', requireModerator, async (req, res, next) => {
  try {
    const user = db.suspendUser(req.params.id, req.session.userId, cleanText(req.body.reason, 500));
    if (!user) return next();
    setFlash(req, 'success', `${user.display_name} is suspended from posting reviews.`);
  } catch (err) {
    setFlash(req, 'error', err.message);
  }
  await saveSession(req);
  res.redirect(req.body.next || '/moderation');
});

app.post('/moderation/users/:id/unsuspend', requireModerator, async (req, res, next) => {
  const user = db.unsuspendUser(req.params.id, req.session.userId);
  if (!user) return next();
  setFlash(req, 'success', `${user.display_name} may post reviews again.`);
  await saveSession(req);
  res.redirect(req.body.next || '/moderation');
});

app.post('/moderation/verifications/:id/approve', requireModerator, async (req, res, next) => {
  try {
    const stillLiving = req.body.still_living === '1' || req.body.still_living === 'on';
    const decided = db.decideVerification(req.params.id, {
      actorId: req.session.userId,
      status: 'approved',
      yearFrom: parseOptionalYear(req.body.year_from),
      yearTo: stillLiving ? null : parseOptionalYear(req.body.year_to),
      stillLiving,
    });
    if (!decided) return next();
    setFlash(req, 'success', `Approved as ${decided.badge}. The uploaded file has been deleted.`);
  } catch (err) {
    setFlash(req, 'error', err.message);
  }
  await saveSession(req);
  res.redirect('/moderation/verification');
});

app.post('/moderation/verifications/:id/reject', requireModerator, async (req, res, next) => {
  try {
    const decided = db.decideVerification(req.params.id, {
      actorId: req.session.userId,
      status: 'rejected',
      rejectReason: cleanText(req.body.reason, 500),
    });
    if (!decided) return next();
    setFlash(req, 'success', 'Request rejected. The uploaded file has been deleted.');
  } catch (err) {
    setFlash(req, 'error', err.message);
  }
  await saveSession(req);
  res.redirect('/moderation/verification');
});

app.use((req, res) => {
  res.status(404).render('404', { title: 'Page not found' });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).render('500', { title: 'Something went wrong' });
});

function blankForm() {
  return {
    street: '',
    city: '',
    state: '',
    zip: '',
    unit: '',
    occupancyType: '',
    yearFrom: null,
    yearTo: null,
    stillLiving: false,
    reviewText: '',
    pros: '',
    cons: '',
    wouldRecommend: null,
    ratings: {},
    anonymous: true,
  };
}

function valuesFromReview(review, property) {
  return {
    street: property ? property.street : '',
    city: property ? property.city : '',
    state: property ? property.state : '',
    zip: property ? property.zip : '',
    unit: review.unit || '',
    occupancyType: review.occupancy_type,
    yearFrom: review.year_from,
    yearTo: review.year_to,
    stillLiving: review.still_living,
    reviewText: review.review_text || '',
    pros: review.pros || '',
    cons: review.cons || '',
    wouldRecommend: review.would_recommend,
    ratings: review.ratings || {},
    anonymous: review.anonymous,
  };
}

function start() {
  db.getDb();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`LivedHere running at http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = { app, start, PORT };
