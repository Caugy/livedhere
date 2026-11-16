'use strict';

/** All rating categories, grouped for the review form and property summaries. All are optional. */
const RATING_GROUPS = [
  {
    id: 'overall',
    label: 'Overall',
    categories: [
      { id: 'overall', label: 'Overall experience' },
      { id: 'value', label: 'Rent / price value' },
    ],
  },
  {
    id: 'management',
    label: 'Landlord & management',
    showIf: 'rented',
    categories: [
      { id: 'landlord_responsiveness', label: 'Landlord / management responsiveness' },
      { id: 'deposit_fairness', label: 'Property manager fairness / deposit return' },
    ],
  },
  {
    id: 'ownership',
    label: 'Ownership',
    showIf: 'owned',
    categories: [
      { id: 'hoa', label: 'HOA' },
    ],
  },
  {
    id: 'condition',
    label: 'Condition & systems',
    categories: [
      { id: 'maintenance', label: 'Maintenance & repairs' },
      { id: 'build_quality', label: 'Build quality / condition' },
      { id: 'pests', label: 'Pests' },
      { id: 'mold', label: 'Mold / moisture' },
      { id: 'plumbing', label: 'Water pressure / plumbing' },
      { id: 'heating', label: 'Heating' },
      { id: 'cooling', label: 'Cooling / AC' },
      { id: 'insulation', label: 'Insulation / drafts' },
      { id: 'air_quality', label: 'Smells / air quality' },
    ],
  },
  {
    id: 'utilities',
    label: 'Utilities & connectivity',
    categories: [
      { id: 'utilities', label: 'Utilities / energy costs' },
      { id: 'internet', label: 'Internet / cell reception' },
    ],
  },
  {
    id: 'living',
    label: 'Layout & living spaces',
    categories: [
      { id: 'noise_inside', label: 'Noise (inside walls)' },
      { id: 'noise_outside', label: 'Noise (street / neighbors)' },
      { id: 'light', label: 'Natural light' },
      { id: 'layout', label: 'Layout / space' },
      { id: 'storage', label: 'Storage' },
      { id: 'kitchen', label: 'Kitchen' },
      { id: 'bathrooms', label: 'Bathrooms' },
      { id: 'laundry', label: 'Laundry' },
    ],
  },
  {
    id: 'access',
    label: 'Access & outdoor',
    categories: [
      { id: 'parking', label: 'Parking' },
      { id: 'outdoor', label: 'Outdoor space / yard' },
      { id: 'pets', label: 'Pet friendliness' },
      { id: 'accessibility', label: 'Accessibility' },
      { id: 'safety', label: 'Safety / security' },
    ],
  },
  {
    id: 'location',
    label: 'Neighborhood & location',
    categories: [
      { id: 'neighborhood', label: 'Neighborhood' },
      { id: 'neighbors', label: 'Neighbors' },
      { id: 'walkability', label: 'Walkability' },
      { id: 'transit', label: 'Public transit' },
      { id: 'schools', label: 'Schools' },
      { id: 'amenities', label: 'Nearby amenities (grocery, restaurants)' },
      { id: 'commute', label: 'Commute' },
    ],
  },
];

const CATEGORY_BY_ID = Object.fromEntries(
  RATING_GROUPS.flatMap((g) => g.categories.map((c) => [c.id, { ...c, groupId: g.id, groupLabel: g.label, showIf: g.showIf || null }]))
);

const ALL_CATEGORY_IDS = Object.keys(CATEGORY_BY_ID);

function parseRatings(input) {
  const ratings = {};
  if (!input || typeof input !== 'object') return ratings;
  for (const id of ALL_CATEGORY_IDS) {
    const raw = input[id];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 5) ratings[id] = n;
  }
  return ratings;
}

function parseRatingsJson(json) {
  if (!json) return {};
  try {
    return parseRatings(typeof json === 'string' ? JSON.parse(json) : json);
  } catch {
    return {};
  }
}

function groupsForOccupancy(occupancy) {
  return RATING_GROUPS.filter((g) => !g.showIf || g.showIf === occupancy);
}

function aggregateRatings(reviews) {
  const sums = {};
  const counts = {};
  for (const review of reviews) {
    const ratings = review.ratings || parseRatingsJson(review.ratings_json);
    for (const [id, value] of Object.entries(ratings)) {
      if (!CATEGORY_BY_ID[id] || typeof value !== 'number') continue;
      sums[id] = (sums[id] || 0) + value;
      counts[id] = (counts[id] || 0) + 1;
    }
  }
  const averages = {};
  for (const id of Object.keys(counts)) {
    averages[id] = Math.round((sums[id] / counts[id]) * 10) / 10;
  }
  const groups = RATING_GROUPS.map((group) => ({
    ...group,
    categories: group.categories
      .filter((c) => counts[c.id])
      .map((c) => ({
        ...c,
        average: averages[c.id],
        count: counts[c.id],
      })),
  })).filter((g) => g.categories.length > 0);

  return {
    averages,
    counts,
    groups,
    overall: averages.overall ?? null,
    overallCount: counts.overall || 0,
  };
}

module.exports = {
  RATING_GROUPS,
  CATEGORY_BY_ID,
  ALL_CATEGORY_IDS,
  parseRatings,
  parseRatingsJson,
  groupsForOccupancy,
  aggregateRatings,
};
