'use strict';

const fs = require('fs');
const path = require('path');
const {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
  DataSet,
  pattern,
} = require('obscenity');

const WORDLIST_PATH = path.join(__dirname, 'wordlists', 'content-filter.json');

let cached;

function loadWordlist() {
  const raw = fs.readFileSync(WORDLIST_PATH, 'utf8');
  const data = JSON.parse(raw);
  return {
    blacklist: (data.blacklist || []).map((item) => (typeof item === 'string' ? { word: item } : item)),
    whitelist: data.whitelist || [],
  };
}

function buildDataset() {
  const wordlist = loadWordlist();
  const dataset = new DataSet().addAll(englishDataset);

  for (const term of wordlist.whitelist) {
    const safe = String(term || '').trim();
    if (!safe) continue;
    dataset.addPhrase((phrase) => phrase.addWhitelistedTerm(safe).addWhitelistedTerm(safe.toLowerCase()));
  }

  for (const item of wordlist.blacklist) {
    const word = String(item.word || '').trim().toLowerCase();
    if (!word) continue;
    dataset.addPhrase((phrase) => {
      phrase.setMetadata({ originalWord: word, category: item.category || 'custom', source: 'custom' });
      phrase.addPattern(compilePattern(word));
      return phrase;
    });
  }

  return { dataset, wordlist };
}

function compilePattern(word) {
  // The pattern DSL treats [], {}, |, and * as syntax. Only allow safe literals.
  if (!/^[a-z0-9]+(?: [a-z0-9]+)*$/.test(word)) {
    throw new Error(`Unsafe content-filter word: ${word}`);
  }
  const parts = word.split(' ').map((w) => w.split(''));
  // Join multi-word phrases with a space; wrap with word boundaries.
  const body = parts.map((chars) => chars.join('')).join(' ');
  return pattern`|${body}|`;
}

function getEngine() {
  if (cached) return cached;
  const { dataset, wordlist } = buildDataset();
  const matcher = new RegExpMatcher({
    ...dataset.build(),
    ...englishRecommendedTransformers,
  });
  cached = { dataset, matcher, wordlist };
  return cached;
}

function resetEngineForTests() {
  cached = null;
}

function payloadWord(engine, match) {
  try {
    const payload = engine.dataset.getPayloadWithPhraseMetadata(match);
    return (payload.phraseMetadata && payload.phraseMetadata.originalWord) || 'flagged';
  } catch {
    return 'flagged';
  }
}

function collectMatches(text) {
  if (!text || !String(text).trim()) return [];
  const engine = getEngine();
  const input = String(text);
  const raw = engine.matcher.getAllMatches(input, true);
  const seen = new Set();
  const matches = [];

  for (const match of raw) {
    const start = match.startIndex;
    const end = match.endIndex;
    const key = `${start}:${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const word = payloadWord(engine, match);
    if (isLikelyProperName(input, start, end, word)) continue;
    matches.push({
      word,
      start,
      end,
      text: input.slice(start, end + 1),
    });
  }

  for (const spaced of findSpacedLetterMatches(input, engine)) {
    const key = `${spaced.start}:${spaced.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push(spaced);
  }

  return matches.sort((a, b) => a.start - b.start || a.end - b.end);
}

function isLikelyProperName(text, start, end, word) {
  if (String(word).toLowerCase() !== 'dick') return false;
  const slice = text.slice(start, end + 1);
  if (slice !== 'Dick') return false;
  const before = text.slice(Math.max(0, start - 24), start);
  const after = text.slice(end + 1, end + 24);
  if (/(?:^|[^\w])(?:Mr|Mrs|Ms|Miss|Dr|Prof|Sir)\.?\s*$/i.test(before)) return true;
  if (/^\s+[A-Z][a-zA-Z'-]+/.test(after)) return true;
  if (/[A-Z][a-zA-Z'-]+\s+$/.test(before)) return true;
  return false;
}

function findSpacedLetterMatches(text, engine) {
  const matches = [];
  const re = /(?<![A-Za-z])((?:[A-Za-z](?:[\s.*_\-]{1,3})){2,}[A-Za-z])(?![A-Za-z])/g;
  let found;
  while ((found = re.exec(text))) {
    const chunk = found[1];
    const letters = chunk.replace(/[^A-Za-z]/g, '');
    if (letters.length < 3) continue;
    const inner = engine.matcher.getAllMatches(letters, true);
    if (!inner.length) continue;
    const word = payloadWord(engine, inner[0]);
    matches.push({
      word,
      start: found.index,
      end: found.index + chunk.length - 1,
      text: chunk,
    });
  }
  return matches;
}

function scan(text) {
  const matches = collectMatches(text);
  return { flagged: matches.length > 0, matches };
}

function scanFields(fields) {
  const matches = [];
  for (const [field, value] of Object.entries(fields || {})) {
    if (value == null || value === '') continue;
    for (const match of collectMatches(String(value))) {
      matches.push({ field, ...match });
    }
  }
  return { flagged: matches.length > 0, matches };
}

function scanReview({ reviewText, pros, cons }) {
  return scanFields({
    review_text: reviewText || '',
    pros: pros || '',
    cons: cons || '',
  });
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function highlight(text, matches, field) {
  const input = String(text || '');
  const relevant = (matches || [])
    .filter((m) => !field || m.field === field)
    .sort((a, b) => a.start - b.start);
  if (!relevant.length) return escapeHtml(input);
  let out = '';
  let cursor = 0;
  for (const match of relevant) {
    const start = Math.max(0, match.start);
    const end = Math.min(input.length, match.end + 1);
    if (start < cursor) continue;
    out += escapeHtml(input.slice(cursor, start));
    out += `<mark class="flagged-term">${escapeHtml(input.slice(start, end))}</mark>`;
    cursor = end;
  }
  out += escapeHtml(input.slice(cursor));
  return out;
}

function anonymousLabel(review) {
  if (review && review.verified && review.occupancy_type === 'owned') return 'Anonymous verified owner';
  if (review && review.verified && review.occupancy_type === 'rented') return 'Anonymous verified renter';
  return 'Anonymous resident';
}

module.exports = {
  WORDLIST_PATH,
  loadWordlist,
  getEngine,
  resetEngineForTests,
  scan,
  scanFields,
  scanReview,
  highlight,
  escapeHtml,
  anonymousLabel,
};
