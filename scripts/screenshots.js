'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const OUT = path.join(__dirname, '..', 'screenshots');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome-stable';

async function login(page, email, password) {
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await page.locator('.auth-form input[name="email"]').fill(email);
  await page.locator('.auth-form input[name="password"]').fill(password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15000 }),
    page.locator('.auth-form button[type="submit"]').click(),
  ]);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(OUT, 'home.png'), fullPage: true });
  console.log('Wrote screenshots/home.png');

  await page.goto(BASE + '/search?q=Example', { waitUntil: 'networkidle' });
  const firstHome = page.locator('.place-card').first();
  await firstHome.waitFor({ timeout: 10000 });
  const href = await firstHome.getAttribute('href');
  await page.goto(BASE + href, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(OUT, 'property.png'), fullPage: true });
  console.log('Wrote screenshots/property.png');

  await login(page, 'demo@livedhere.example', 'LivedHereDemo1');

  await page.goto(BASE + '/review', { waitUntil: 'networkidle' });
  await page.waitForSelector('.review-form');
  await page.screenshot({ path: path.join(OUT, 'review-form.png'), fullPage: true });
  console.log('Wrote screenshots/review-form.png');

  await page.goto(BASE + '/search?q=Example', { waitUntil: 'networkidle' });
  const placeholder = page.locator('.place-card').first();
  await placeholder.waitFor({ timeout: 10000 });
  const phref = await placeholder.getAttribute('href');
  await page.goto(BASE + phref, { waitUntil: 'networkidle' });
  const reportBtn = page.locator('.js-open-report').first();
  await reportBtn.click();
  await page.waitForSelector('#report-dialog[open], #report-form');
  await page.screenshot({ path: path.join(OUT, 'report.png'), fullPage: true });
  console.log('Wrote screenshots/report.png');

  await page.evaluate(() => document.getElementById('report-dialog')?.close());
  await page.locator('form[action="/logout"] button').click();
  await page.waitForURL((url) => url.pathname === '/' || url.pathname === '/login', { timeout: 15000 });

  await login(page, 'moderator@livedhere.example', 'LivedHereMod1');
  await page.goto(BASE + '/moderation', { waitUntil: 'networkidle' });
  await page.waitForSelector('.mod-card, .empty');
  await page.screenshot({ path: path.join(OUT, 'moderation.png'), fullPage: true });
  console.log('Wrote screenshots/moderation.png');

  await page.goto(BASE + '/moderation/verification', { waitUntil: 'networkidle' });
  await page.waitForSelector('.mod-card, .empty');
  await page.screenshot({ path: path.join(OUT, 'verification.png'), fullPage: true });
  console.log('Wrote screenshots/verification.png');

  await page.goto(BASE + '/moderation/approval', { waitUntil: 'networkidle' });
  await page.waitForSelector('.mod-card, .empty');
  await page.screenshot({ path: path.join(OUT, 'approval-queue.png'), fullPage: true });
  console.log('Wrote screenshots/approval-queue.png');

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
