# TechTalent Portal 🌐

**Free IT talent & freelance jobs portal — built by Purnachandar Padishala**

[![Live Site](https://img.shields.io/badge/Live%20Site-purnappc8.github.io-blue)](https://purnappc8.github.io/resume-portal/)
[![All Technologies](https://img.shields.io/badge/All%20Technologies-Open%20to%20All-green)](https://purnappc8.github.io/resume-portal/)

---

## 🚀 Live URL

👉 **[https://purnappc8.github.io/resume-portal/](https://purnappc8.github.io/resume-portal/)**

---

## 📋 Features

### For Job Seekers & Freelancers
- ✅ **Free profile** — post resume, get discovered by recruiters
- ✅ **All technologies** — Salesforce, Java, Python, React, DevOps, SAP, .NET, and more
- ✅ **Freelance job board** — aggregated from Indeed, LinkedIn, Upwork, Freelancer.com, Toptal, Guru, PeoplePerHour
- ✅ **One-click apply** — opens job on source platform
- ✅ **Application tracker** — see all your applications in one dashboard
- ✅ **Job alerts** — get notified for new matching jobs
- 🔜 **Connect portals** — sync application status from Indeed/LinkedIn/Upwork (coming soon)

### For Recruiters / Hiring Managers
- ✅ **Browse profiles** — filter by tech, experience, location, availability
- ✅ **Contact candidates** — send message directly from portal
- ✅ **All roles** — not limited to Salesforce; full IT spectrum
- ✅ **Free** — always free

---

## 🏗️ Architecture

```
GitHub Pages (free hosting)        Your PC (E: drive)
┌────────────────────────┐         ┌──────────────────────────────┐
│  index.html            │ ──API──▶│  server/server.js (port 4747) │
│  jobs.html             │ calls   │  E:\ResumePortal\data\        │
│  submit.html           │         │  ├─ profiles.json             │
│  dashboard.html        │         │  ├─ users.json                │
│  profile.html          │         │  ├─ applications.json         │
└────────────────────────┘         │  ├─ contacts.json             │
                                   │  └─ pdfs\  (PDF resumes)      │
                                   └──────────────────────────────┘
```

**Why this design:**
- GitHub Pages = free, permanent public URL, zero hosting cost
- Local server = all data stays on your E: drive, zero cloud storage cost
- No database subscription needed

---

## ⚙️ Setup

### 1. GitHub Pages (hosting — already done)
The site is live at `https://purnappc8.github.io/resume-portal/`

### 2. Local Server (for storing user data on E: drive)

**Prerequisites:** [Node.js](https://nodejs.org) (free, install once)

```bash
# On your Windows PC:
cd E:\ResumePortal\server
node server.js
# OR just double-click: start-server.bat
```

The server:
- Runs on `http://localhost:4747`
- Stores ALL data in `E:\ResumePortal\data\`
- Must be running for signups, profile submissions, and contact forms to persist

> **Note:** When the server is offline, the site still works — it shows seed profiles and job listings. New submissions are saved in the browser (localStorage) until the server is restarted.

### 3. Auto-start server on PC boot (optional)
1. Press `Win + R` → type `shell:startup`
2. Copy `start-server.bat` shortcut into the Startup folder
3. Server will start automatically with your PC

---

## 📁 Data Files (E:\ResumePortal\data\)

| File | Contents |
|------|----------|
| `profiles.json` | All public resume profiles |
| `users.json` | Registered accounts (hashed passwords) |
| `applications.json` | All job applications tracked |
| `contacts.json` | Recruiter contact messages |
| `pdfs/` | Uploaded PDF resumes |

---

## 🛠️ Pages

| Page | URL | Description |
|------|-----|-------------|
| `index.html` | `/` | Browse all IT profiles |
| `jobs.html` | `/jobs.html` | Freelance job board (multi-source) |
| `submit.html` | `/submit.html` | Post your resume (3-step wizard) |
| `dashboard.html` | `/dashboard.html` | Personal dashboard (applications, saved, alerts) |
| `profile.html` | `/profile.html` | Individual public profile |

---

## 🔮 Roadmap

- [ ] **OAuth integration** — connect Indeed/LinkedIn/Upwork accounts to auto-sync application status
- [ ] **Email alerts** — notify candidates of new matching jobs
- [ ] **Admin panel** — manage profiles and moderate listings
- [ ] **Company accounts** — let recruiters post jobs directly
- [ ] **AI matching** — suggest best-fit jobs based on profile

---

## 👤 Admin / Owner

**Purnachandar Padishala**  
IT Analyst · Salesforce Developer · TCS  
📧 purna.padishala@gmail.com  
🔗 [linkedin.com/in/purnappc](https://linkedin.com/in/purnappc)

---

*Built with ❤️ — Free forever for IT professionals worldwide*
