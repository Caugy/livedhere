'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livedhere-test-'));
process.env.LIVEDHERE_DATA_DIR = dataDir;
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-for-unit-tests';
process.env.ADMIN_PASSWORD = 'TestAdminPassword1';

const db = require('../db');
const policy = require('../policy');
const { app } = require('../server');

function sampleReview(overrides = {}) {
  return {
    occupancyType: 'rented',
    yearFrom: 2024,
    yearTo: 2025,
    stillLiving: false,
    reviewText: 'A calm sample review used for volume moderation tests. The heat worked and the street was quiet.',
    pros: 'Quiet street.',
    cons: 'Small closets.',
    wouldRecommend: 1,
    ratings: { overall: 4 },
    anonymous: 1,
    isSample: true,
    ...overrides,
  };
}

function createFreshUser(email, { role = 'user' } = {}) {
  return db.createUser({
    email,
    password: 'TestPassword1',
    displayName: email.split('@')[0],
    isDemo: false,
    role,
  });
}

function ensureProperty() {
  return db.findOrCreateProperty({
    street: '200 Volume Test Ave',
    city: 'Springfield',
    state: 'IL',
    zip: '62701',
  });
}

describe('volume moderation', () => {
  let property;

  before(() => {
    db.getDb();
    property = ensureProperty();
  });

  it('publishes a user\'s first review in a 24-hour window', () => {
    const user = createFreshUser('first-review@example.test');
    const review = db.insertReview({
      ...sampleReview(),
      propertyId: property.id,
      userId: user.id,
    });
    assert.equal(review.moderation_status, 'published');
    assert.equal(review.isPending, false);
    assert.deepEqual(review.moderationReasons, []);
  });

  it('holds a second review in 24 hours with a clear volume reason', () => {
    const user = createFreshUser('second-review@example.test');
    const first = db.insertReview({
      ...sampleReview(),
      propertyId: property.id,
      userId: user.id,
    });
    const second = db.insertReview({
      ...sampleReview({ reviewText: 'A second clean review from the same person later the same day.' }),
      propertyId: property.id,
      userId: user.id,
    });
    assert.equal(first.moderation_status, 'published');
    assert.equal(second.moderation_status, 'pending');
    assert.ok(second.moderationReasons.includes('volume_24h'));
    assert.ok(second.moderationReasonLabels.includes('Multiple reviews within 24 hours'));
    assert.equal(second.isPending, true);
  });

  it('counts reviews of any status in the 24-hour window', () => {
    const user = createFreshUser('any-status@example.test');
    const first = db.insertReview({
      ...sampleReview({ reviewText: 'This first one is flagged as shit so it is already pending.' }),
      propertyId: property.id,
      userId: user.id,
    });
    assert.equal(first.moderation_status, 'pending');
    assert.ok(first.moderationReasons.includes('content_filter'));
    assert.equal(first.moderationReasons.includes('volume_24h'), false);

    const second = db.insertReview({
      ...sampleReview({ reviewText: 'A later clean review should still be held for volume.' }),
      propertyId: property.id,
      userId: user.id,
    });
    assert.equal(second.moderation_status, 'pending');
    assert.ok(second.moderationReasons.includes('volume_24h'));
    assert.equal(second.moderationReasons.includes('content_filter'), false);
  });

  it('adds both content-filter and volume reasons when a second review is flagged', () => {
    const user = createFreshUser('both-reasons@example.test');
    db.insertReview({
      ...sampleReview(),
      propertyId: property.id,
      userId: user.id,
    });
    const second = db.insertReview({
      ...sampleReview({ reviewText: 'A second review that also says this place is a piece of shit.' }),
      propertyId: property.id,
      userId: user.id,
    });
    assert.equal(second.moderation_status, 'pending');
    assert.ok(second.moderationReasons.includes('volume_24h'));
    assert.ok(second.moderationReasons.includes('content_filter'));
  });

  it('does not hold a new review if the earlier one is older than 24 hours', () => {
    const user = createFreshUser('older-review@example.test');
    const first = db.insertReview({
      ...sampleReview(),
      propertyId: property.id,
      userId: user.id,
    });
    db.getDb()
      .prepare("UPDATE reviews SET created_at = datetime('now', '-25 hours') WHERE id = ?")
      .run(first.id);
    const second = db.insertReview({
      ...sampleReview({ reviewText: 'This should publish because the earlier review is outside the window.' }),
      propertyId: property.id,
      userId: user.id,
    });
    assert.equal(second.moderation_status, 'published');
    assert.deepEqual(second.moderationReasons, []);
  });

  it('exempts moderators and admins from the volume hold', () => {
    const moderator = createFreshUser('staff-mod@example.test', { role: 'moderator' });
    const admin = createFreshUser('staff-admin@example.test', { role: 'admin' });
    const firstMod = db.insertReview({ ...sampleReview(), propertyId: property.id, userId: moderator.id });
    const secondMod = db.insertReview({
      ...sampleReview({ reviewText: 'Moderator second review the same day.' }),
      propertyId: property.id,
      userId: moderator.id,
    });
    const firstAdmin = db.insertReview({ ...sampleReview(), propertyId: property.id, userId: admin.id });
    const secondAdmin = db.insertReview({
      ...sampleReview({ reviewText: 'Admin second review the same day.' }),
      propertyId: property.id,
      userId: admin.id,
    });
    assert.equal(firstMod.moderation_status, 'published');
    assert.equal(secondMod.moderation_status, 'published');
    assert.equal(firstAdmin.moderation_status, 'published');
    assert.equal(secondAdmin.moderation_status, 'published');
  });

  it('keeps a volume hold if the author edits the pending review', () => {
    const user = createFreshUser('edit-held@example.test');
    db.insertReview({ ...sampleReview(), propertyId: property.id, userId: user.id });
    const second = db.insertReview({
      ...sampleReview({ reviewText: 'Second review held for volume, later edited.' }),
      propertyId: property.id,
      userId: user.id,
    });
    const updated = db.updateReview(second.id, {
      propertyId: property.id,
      occupancyType: 'rented',
      yearFrom: 2024,
      yearTo: 2025,
      stillLiving: false,
      reviewText: 'Edited wording, still a clean review, should remain pending for volume.',
      pros: 'Quiet street.',
      cons: 'Small closets.',
      wouldRecommend: 1,
      ratings: { overall: 4 },
      anonymous: 1,
    });
    assert.equal(updated.moderation_status, 'pending');
    assert.ok(updated.moderationReasons.includes('volume_24h'));
  });

  it('puts volume-held reviews in the existing approval queue with the reason label', () => {
    const user = createFreshUser('queue-label@example.test');
    db.insertReview({ ...sampleReview(), propertyId: property.id, userId: user.id });
    const second = db.insertReview({
      ...sampleReview({ reviewText: 'This one should appear in the approval queue for volume.' }),
      propertyId: property.id,
      userId: user.id,
    });
    const item = db.getApprovalQueue().find((entry) => entry.review.id === second.id);
    assert.ok(item, 'expected the volume-held review in the approval queue');
    assert.ok(item.reasonLabels.includes('Multiple reviews within 24 hours'));
  });
});

describe('disclaimer page and review agreement', () => {
  let server;
  let base;

  before(async () => {
    db.getDb();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  function request(pathname, { method = 'GET', body, headers = {}, cookies = '' } = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(pathname, base);
      const payload = body ? (typeof body === 'string' ? body : new URLSearchParams(body).toString()) : null;
      const req = http.request(
        url,
        {
          method,
          headers: {
            ...(payload
              ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(payload) }
              : {}),
            ...(cookies ? { cookie: cookies } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const jarMap = new Map();
            for (const part of (cookies || '').split(';')) {
              const piece = part.trim();
              if (!piece || !piece.includes('=')) continue;
              jarMap.set(piece.slice(0, piece.indexOf('=')), piece);
            }
            for (const value of res.headers['set-cookie'] || []) {
              const piece = value.split(';')[0];
              if (!piece || !piece.includes('=')) continue;
              jarMap.set(piece.slice(0, piece.indexOf('=')), piece);
            }
            const jar = [...jarMap.values()].join('; ');
            resolve({ status: res.statusCode, headers: res.headers, text, cookies: jar, location: res.headers.location });
          });
        }
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  it('serves the disclaimer page with the expected notice', async () => {
    const res = await request('/disclaimer');
    assert.equal(res.status, 200);
    assert.match(res.text, /Last updated:\s*November 2026/);
    assert.match(res.text, /user-generated content/i);
    assert.match(res.text, /opinions of the individual users/i);
    assert.match(res.text, /does not verify/i);
    assert.match(res.text, /Verified renter/);
    assert.match(res.text, /as is/i);
    assert.match(res.text, /not legal, financial, or real estate advice/i);
    assert.match(res.text, /Report/i);
    assert.match(res.text, /property owners/i);
    assert.match(res.text, /Section 230/);
    assert.match(res.text, /Limitation of liability/i);
    assert.match(res.text, /general notice/i);
  });

  it('links to the disclaimer from the site footer', async () => {
    const res = await request('/');
    assert.equal(res.status, 200);
    assert.match(res.text, /href="\/disclaimer"/);
    assert.match(res.text, />Disclaimer</);
  });

  it('rejects a new review posted without agreeing to the disclaimer', async () => {
    const loginPage = await request('/login');
    const csrf = loginPage.text.match(/name="_csrf"\s+value="([^"]+)"/);
    assert.ok(csrf, 'csrf on login page');
    const loggedIn = await request('/login', {
      method: 'POST',
      cookies: loginPage.cookies,
      body: {
        _csrf: csrf[1],
        email: db.DEMO_EMAIL,
        password: db.DEMO_PASSWORD,
        next: '/review',
      },
    });
    assert.equal(loggedIn.status, 302);

    const form = await request('/review', { cookies: loggedIn.cookies });
    const formCsrf = form.text.match(/name="_csrf"\s+value="([^"]+)"/);
    assert.ok(formCsrf, 'csrf on review form');
    assert.match(form.text, /I confirm this review reflects my honest experience/);
    assert.match(form.text, /href="\/disclaimer"/);

    const submitted = await request('/review', {
      method: 'POST',
      cookies: form.cookies || loggedIn.cookies,
      body: {
        _csrf: formCsrf[1],
        street: '10 Disclaimer Test St',
        city: 'Springfield',
        state: 'IL',
        zip: '62701',
        occupancy_type: 'rented',
        review_text: 'A clean test review posted without checking the box.',
      },
    });
    assert.equal(submitted.status, 400);
    assert.match(submitted.text, /agree to the Disclaimer/);
  });
});

after(() => {
  db.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
