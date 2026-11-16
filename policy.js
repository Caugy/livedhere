'use strict';

const REPORT_REASONS = [
  { id: 'false_misleading', label: 'False or misleading' },
  { id: 'harassment', label: 'Harassment or personal information about a named person' },
  { id: 'spam', label: 'Spam or ads' },
  { id: 'not_resident', label: 'Not a real resident' },
  { id: 'hate', label: 'Hate or offensive content' },
  { id: 'other', label: 'Other' },
];

const RENTER_DOCUMENTS = [
  { id: 'lease', label: 'Lease' },
  { id: 'rent_receipt', label: 'Rent receipt' },
  { id: 'utility_bill', label: 'Utility bill' },
  { id: 'renters_insurance', label: "Renter's insurance" },
];

const OWNER_DOCUMENTS = [
  { id: 'deed', label: 'Deed' },
  { id: 'closing_disclosure', label: 'Closing disclosure' },
  { id: 'property_tax', label: 'Property tax bill' },
  { id: 'mortgage', label: 'Mortgage statement' },
  { id: 'homeowners_insurance', label: "Homeowner's insurance" },
];

const ALL_DOCUMENTS = [...RENTER_DOCUMENTS, ...OWNER_DOCUMENTS];

const AUTO_HIDE_THRESHOLD = 3;
const AUTO_HIDE_REASON =
  'This review was hidden pending moderation because it received multiple reports.';

const MOD_EMAIL = 'moderator@livedhere.example';
const MOD_PASSWORD = 'LivedHereMod1';
const MOD_NAME = 'Demo Moderator';

function reasonLabel(id) {
  return (REPORT_REASONS.find((r) => r.id === id) || {}).label || id;
}

function documentLabel(id) {
  return (ALL_DOCUMENTS.find((d) => d.id === id) || {}).label || id;
}

function documentsFor(occupancy) {
  return occupancy === 'owned' ? OWNER_DOCUMENTS : RENTER_DOCUMENTS;
}

function isAllowedDocument(occupancy, documentType) {
  return documentsFor(occupancy).some((d) => d.id === documentType);
}

function isStaff(user) {
  return Boolean(user && (user.role === 'moderator' || user.role === 'admin'));
}

function isSuspended(user) {
  return Boolean(user && user.status === 'suspended');
}

function verificationBadge(occupancy) {
  return occupancy === 'owned' ? 'Verified owner' : 'Verified renter';
}

module.exports = {
  REPORT_REASONS,
  RENTER_DOCUMENTS,
  OWNER_DOCUMENTS,
  ALL_DOCUMENTS,
  AUTO_HIDE_THRESHOLD,
  AUTO_HIDE_REASON,
  MOD_EMAIL,
  MOD_PASSWORD,
  MOD_NAME,
  reasonLabel,
  documentLabel,
  documentsFor,
  isAllowedDocument,
  isStaff,
  isSuspended,
  verificationBadge,
};
