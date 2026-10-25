# Job search service ("From across the web")

When someone searches on **Browse Jobs**, the page asks this small service, which
searches **Jooble, Adzuna and JSearch** at the same time and returns one combined
list. Each result links to the original job listing.

It runs free on **Cloudflare Workers**. API keys are stored as Cloudflare *secrets*,
so they never appear in the website or this repository.

## One-time setup (about 10 minutes)

### 1. Get the keys
| Service | Where | What you get |
|---|---|---|
| Jooble | https://jooble.org/api/about → fill the form | Key arrives by email |
| Adzuna | https://developer.adzuna.com/signup → register → dashboard | **App ID** + **App Key** |
| JSearch (optional) | https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch → Pricing → Basic (free) | **X-RapidAPI-Key** |

You don't need all of them — any source without a key is skipped.

### 2. Create the worker on Cloudflare
1. https://dash.cloudflare.com → **Workers & Pages** → **Create** → **Create Worker**.
2. Name it **`techtalent-search`** → **Deploy**.
3. **Edit code** → delete the sample → paste everything from `search-worker.js` → **Deploy**.

### 3. Add the keys (secrets)
Worker → **Settings** → **Variables and Secrets** → **Add**, type **Secret**:

| Name | Value |
|---|---|
| `JOOBLE_KEY` | your Jooble key |
| `ADZUNA_APP_ID` | your Adzuna App ID |
| `ADZUNA_APP_KEY` | your Adzuna App Key |
| `RAPIDAPI_KEY` | your RapidAPI key (optional) |

Then **Deploy** again.

### 4. Check it
Open `https://techtalent-search.<your-subdomain>.workers.dev/health` — it shows which
sources are switched on (`true` / `false`; it never shows the keys).

### 5. Connect the website
In `jobs.html`, set:
```js
const WEB_SEARCH_URL = 'https://techtalent-search.<your-subdomain>.workers.dev';
```
Until this is set, Browse Jobs simply doesn't show the web-results section; the
"Search everywhere" links keep working.

## How it protects your free quotas
- Searches run only after you stop typing (and need 2+ characters).
- Each search is cached for **6 hours** on Cloudflare, and for 30 minutes in the browser.
- JSearch (smallest free tier) is used only for the first page of results.
- Only the TechTalent site (and local testing) may call the service.

## Endpoints
- `GET /search?q=salesforce developer&loc=india|us|uk|remote&type=contract|freelance|part-time|full-time&page=1`
- `GET /health`

---

# Recruiter accounts ("Recruiter Portal")

`accounts-worker.js` runs the recruiter portal (`recruiter.html`):

- An organization registers with its **group email** on its own company domain
  (free addresses like Gmail are refused). Nothing works until someone **confirms
  from that group mailbox**.
- Each organization has a **seat limit** (default 5) for active + pending recruiters.
- Each recruiter has their **own username and password**; their account email is
  the group email.
- A new recruiter's request is **emailed only to the group email** with
  Approve / Decline. They can't sign in until approved.
- Passwords are hashed (PBKDF2-SHA256); 5 wrong passwords lock the account for 15 minutes.
- Email links open a confirmation page — the action happens on the button, so
  mail scanners that pre-open links can't approve anyone.
- Once live, **only signed-in recruiters can contact candidates** or schedule calls.

### Candidates (same service)
- **Post Resume** stores the profile here; it's **published only after the candidate
  confirms by email**. Their email and phone are **never** shown publicly.
- A change submitted with an existing email waits for the owner's confirmation
  (nobody can overwrite someone else's profile).
- A recruiter's message or call request is emailed **only to that candidate**, with
  **Reply-To set to the recruiter's group email**. Limits: 3 per candidate per day,
  50 per recruiter per day.
- Candidates open their **Inbox** with an emailed sign-in link (no password) and see
  only their own messages. They can **hide** or **delete** their profile and data.
- Resume PDFs aren't stored in the cloud yet (candidates can add their LinkedIn).

## Setup (about 15 minutes)

### 1. Email sending — Brevo (free)
1. Sign up at https://www.brevo.com (free plan).
2. **Senders, domains & dedicated IPs → Senders → Add a sender**: use an address you
   own (e.g. your Gmail) and confirm the verification email.
3. **SMTP & API → API keys → Generate a new API key**. Keep it for step 3.

### 2. Database + worker (Cloudflare)
1. Cloudflare → **Storage & Databases → D1 → Create database** → name `techtalent-accounts`.
2. Open it → **Console** → paste everything from `accounts-schema.sql` → **Execute**
   (it creates the organization, recruiter, candidate and message tables).
3. **Workers & Pages → Create → Create Worker** → name `techtalent-accounts` → Deploy →
   **Edit code** → paste `accounts-worker.js` → Deploy.
4. Worker → **Settings → Bindings → Add → D1 database** → variable name `DB` →
   database `techtalent-accounts`.

### 3. Settings (Worker → Settings → Variables and Secrets)
| Name | Type | Value |
|---|---|---|
| `BREVO_API_KEY` | **Secret** | your Brevo API key |
| `MAIL_FROM` | Text | the sender you verified in Brevo |
| `MAIL_FROM_NAME` | Text | `TechTalent Portal` (optional) |
| `SEAT_LIMIT` | Text | `5` (optional) |

Deploy again, then open `https://techtalent-accounts.<your-subdomain>.workers.dev/health`
— it should show `"database": true, "email": true`.

### 4. Switch it on
In `nav.js` set:
```js
RECRUITER_API_URL: 'https://techtalent-accounts.<your-subdomain>.workers.dev'
```
From then on, recruiters sign in at **Recruiters** in the menu, and contacting
candidates requires a recruiter account.

### Changing one organization's seat limit
D1 → `techtalent-accounts` → Console:
```sql
UPDATE orgs SET seat_limit = 10 WHERE group_email = 'hiring@company.com';
```
