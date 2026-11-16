'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const filter = require('../content-filter');

function flagged(text) {
  return filter.scan(text).flagged;
}

function words(text) {
  return filter.scan(text).matches.map((m) => m.word.toLowerCase());
}

describe('content filter true positives', () => {
  it('flags common profanity in a review-like sentence', () => {
    assert.equal(flagged('This place is a piece of shit, honestly.'), true);
    assert.ok(words('This place is a piece of shit, honestly.').includes('shit'));
  });

  it('flags slurs and sexual terms from the base dataset', () => {
    assert.equal(flagged('The landlord called me a bitch and worse.'), true);
  });

  it('flags custom drug terms', () => {
    assert.equal(flagged('There was a meth lab in the basement.'), true);
    assert.equal(flagged('Dealers sold fentanyl in the hallway.'), true);
    assert.equal(flagged('People were using heroin in the stairwell.'), true);
  });

  it('flags custom graphic violence terms', () => {
    assert.equal(flagged('A beheading video was playing in the unit.'), true);
  });
});

describe('content filter evasions', () => {
  it('flags leetspeak and symbol substitutions', () => {
    assert.equal(flagged('f*ck this landlord'), true);
    assert.equal(flagged('What a pile of sh1t'), true);
    assert.equal(flagged('$h1t in the hallway'), true);
    assert.equal(flagged('a$$hole behavior from management'), true);
  });

  it('flags repeated letters', () => {
    assert.equal(flagged('fuuuck this deposit process'), true);
    assert.equal(flagged('This is shiiit'), true);
  });

  it('flags spaced letters', () => {
    assert.equal(flagged('This landlord can go f u c k himself'), true);
    assert.equal(flagged('The unit was s h i t'), true);
    assert.equal(flagged('a s s h o l e of a manager'), true);
  });
});

describe('content filter false positives', () => {
  it('does not flag ordinary housing language', () => {
    assert.equal(flagged('The kitchen is classic and the closets are classy enough.'), false);
    assert.equal(flagged('Please assess the damage to the hallway carpet.'), false);
    assert.equal(flagged('We lived in Essex for two years.'), false);
    assert.equal(flagged('A team trip to Scunthorpe was the only hassle.'), false);
    assert.equal(flagged('There was a cockroach in the kitchen once.'), false);
    assert.equal(flagged('The plaster is cracked and the walls have hairline cracks.'), false);
    assert.equal(flagged('Weeds in the yard were the biggest complaint.'), false);
  });

  it('does not flag Dick as a surname or given name next to another name', () => {
    assert.equal(flagged('Dick Cheney lived nearby, according to a neighbor.'), false);
    assert.equal(flagged('The previous owner was Philip Dick.'), false);
    assert.equal(flagged('Mr. Dick signed the lease.'), false);
  });

  it('still flags dick used as an insult', () => {
    assert.equal(flagged('The manager was a real dick about the deposit.'), true);
  });
});

describe('field scanning and highlighting', () => {
  it('scans review fields and can highlight matches', () => {
    const result = filter.scanReview({
      reviewText: 'Fine light, but the landlord was an asshole.',
      pros: 'Bright kitchen',
      cons: 'Nothing else',
    });
    assert.equal(result.flagged, true);
    assert.ok(result.matches.some((m) => m.field === 'review_text'));
    const html = filter.highlight('the landlord was an asshole.', result.matches, 'review_text');
    assert.match(html, /<mark class="flagged-term">/);
    assert.equal(filter.highlight('safe text', [], 'review_text'), 'safe text');
  });

  it('returns not flagged for empty input', () => {
    assert.equal(filter.scan('').flagged, false);
    assert.equal(filter.scanReview({ reviewText: '', pros: '', cons: '' }).flagged, false);
  });
});
