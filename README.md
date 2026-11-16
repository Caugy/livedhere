# LivedHere

A first working version of a website where people review houses and apartments they have actually lived in — rented or owned.

Listing sites show the tour. LivedHere is for the years after you get the keys: noise, repairs, landlords, HOA, utilities, neighbors, and whatever else residents want to say.

**Working name on this build:** LivedHere  
**Other name ideas:** AfterStay, ResidentRecord

## Features

- Public home page with address / city / ZIP search
- Property pages with aggregate ratings, a rented vs owned filter, a verified-only filter, and a list of reviews
- Reviews are tied to an account. Browsing and reading are public; posting, editing, and deleting require a login
- Review form starts with an open-ended write-up. After that, many optional 1–5 star categories are grouped into collapsible sections. Pros, cons, and “would you recommend?” come last
- Only the address and whether you rented or owned are required
- Reviewers can show their display name or post without a name
- Signed-in users can report someone else’s review once, with a reason and optional details
- Moderators and admins use `/moderation` to handle reports, hide/restore/delete reviews, suspend authors from posting, and review renter/owner verification requests
- A review is auto-hidden pending moderation after 3 open reports from distinct users. Hidden reviews are excluded from public pages and aggregate ratings. Authors still see the review and the reason
- Residents can request renter or owner verification by uploading a document (PDF/JPG/PNG, 10 MB max). Files are stored privately, shown only to staff, and deleted after a decision. Approved reviews show a Verified renter or Verified owner badge
- There are no email notifications; users and moderators check the site (account page or dashboard)
- Reviews default to posting anonymously (toggle off if you want your display name shown). Public bylines are “Anonymous resident,” “Anonymous verified renter,” or “Anonymous verified owner.” Unverified users can still post; verification adds the badge only
- An automatic content filter holds reviews with profanity or similar language for moderator approval instead of blocking them. Display names that trip the filter are rejected
- Sample / example reviews use fictional addresses such as `123 Example St` and are clearly marked

## Requirements

- Node.js 18 or later

## Run it locally

```bash
cd house-reviews
npm install
npm start
```

Then open [http://localhost:3000](http://localhost:3000).

The SQLite database is created at `data/reviews.db` on first run and seeded automatically if it is empty. To reset the demo data:

```bash
npm run seed
```

Set `PORT` (default `3000`) if you want. A random session secret is generated in `data/session-secret.txt` (not committed). You can override it with the `SESSION_SECRET` environment variable. Do not put real secrets in this README.

## Demo accounts

**Resident** (write reviews, report, request verification):

- **Email:** `demo@livedhere.example`
- **Password:** `LivedHereDemo1`
- **Display name:** Demo Resident

**Moderator** (dashboard at `/moderation`, including reports, verification, and the audit log):

- **Email:** `moderator@livedhere.example`
- **Password:** `LivedHereMod1`
- **Display name:** Demo Moderator

A sample report queue item (12 Placeholder Rd) and a sample pending lease upload for 123 Example St are included so the dashboard is not empty.

## Project layout

```
house-reviews/
  server.js          Express app, routes, auth
  db.js              SQLite schema, queries, seed data
  ratings.js         Rating categories and aggregates
  policy.js          Report reasons, roles, verification document types
  uploads.js         Private file storage and MIME/magic-byte checks
  session-store.js   Session cookies stored in SQLite
  public/            CSS, client JS, favicon (no uploaded documents)
  views/             EJS templates
  data/reviews.db    Created at runtime
  data/private/      Uploaded proof documents (staff-only)
  screenshots/       Page captures
  scripts/           Screenshot helper
```

## Known limitations

- Not deployed — this is a local MVP
- No email verification, password reset, or email notifications
- The content filter is a heuristic (leetspeak and spaced letters are covered, but it can both miss disguised language and flag edge cases). Moderators make the final call
- No CSRF tokens, rate limiting, or production hardening
- Verification is a manual staff review of a document, not a legal identity or title check
- No maps, photo uploads on reviews, or official property records
- Addresses are grouped by street + city + state + ZIP (building level). Unit is stored on the review
- Sample reviews are fictional and marked as such
