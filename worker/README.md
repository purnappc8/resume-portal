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
