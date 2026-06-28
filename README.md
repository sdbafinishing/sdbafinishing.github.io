# SDBA RDMS — Race Day Management System

A browser-based race-day management app for dragon-boat regattas (SDBA). It runs
the full finish-line workflow: import draws, time races, import Joyi results,
score divisions, generate next-round draws, and publish results — live, on the
day, often over a slow venue uplink.

**Live app:** <https://sdbafinishing.github.io/rdms/>

---

## What it does

- **Race processing** — Excel-like input grid, START/FINISH with millisecond
  precision, Joyi result import (`.xls` / `.jyd` / `.lcd`), penalties, status
  markers (DNS/DSQ/DNF/DQ), validation, and one-click export + WhatsApp send.
- **Photo finish** — renders the Joyi line-scan image with reach-line overlays,
  finish times, and a crop-and-save tool; publishes a small finish JPEG for the
  online/iPad viewer.
- **Scoring** — selectable per division: weighted **points** (default),
  **combined time** (#1), or **sum of times** (#2); plus **tiered standings**
  (Gold/Silver/Bronze cups + Bowl) with section + stacked overall ranks.
- **Next-round draws** — resolves `R{n}P{n}` / `R{list}P{p}` / `SUMR{list}P{p}`
  placeholders from completed results and writes finished draws (`.xlsx`).
- **Dashboard / TimeSheet / Flowchart** — progress, delay tracking, digital
  flags, and a bracket-style progression graph.
- **Live + offline** — local IndexedDB is the source of truth; push-only sync to
  Supabase powers the web viewer; Firebase drives the real-time digital flags.

A full in-app **User Guide** lives under **Setup → User Guide** (the most
detailed and current reference).

---

## Architecture

- **Vanilla JS ES modules + [Vite](https://vitejs.dev/) 6** — no framework.
- **[Dexie](https://dexie.org/) / IndexedDB** — all race data, local-first.
- **[Supabase](https://supabase.com/)** — push-only sync for the web viewer,
  users, and the past-events archive.
- **Firebase Realtime DB** — digital flags + current-race number (truly live).
- **xlsx generation** — result/draw sheets are patched cell-by-cell into a
  bundled `templates/race-template.xlsx` via [fflate](https://github.com/101arrowz/fflate),
  preserving all formatting. Joyi start lists are hand-built BIFF8 `.xls`
  (Joyi only reads legacy `.xls`); SprintTimer lists are `.csv`.
- **Hosting** — GitHub Pages; a GitHub Action builds `rdms/` and deploys on every
  push to `main` that touches `rdms/**`.

Source lives in [`rdms/`](rdms/): `js/` (modules), `js/pages/` (page views),
`css/`, `templates/`, `tests/smoke.mjs`.

---

## Running locally

```bash
cd rdms
npm install
npm run dev      # vite dev server on http://localhost:3000 (strict port)
```

Vite serves the working tree directly, so edits show up immediately — no build
needed for local race-day operation. On macOS you can also double-click
**`Launch RDMS.command`** at the repo root.

> Port is locked to **3000** on purpose: Google OAuth (Drive API) requires every
> dev origin to be pre-registered, so Vite fails fast if 3000 is busy instead of
> drifting to another port.

### Build & test

```bash
cd rdms
npm run build              # → dist/
node tests/smoke.mjs       # fast unit/smoke suite (no browser)
```

### First-run setup

1. **Setup → Event** — fill in event details, lanes, scoring, folders.
2. **Connect Folder** (top nav) — grant access to the event folder; RDMS finds
   `01 Input_Draw/`, `12 Output_Results/`, etc. inside it.
3. **Im/Export → Import Draws** — load draws from `01 Input_Draw/`.
4. **Setup → Divisions** — configure rounds, progressions, and scoring method.

---

## Event folder layout

RDMS reads from and writes to a single event folder (local or Drive-synced):

| Folder | Use |
| --- | --- |
| `01 Input_Draw/` | Draw `.xls` files (input — read; never overwritten) |
| `11 Output_Start Lists/` | Joyi `.xls` + SprintTimer `.csv` start lists |
| `12 Output_Results/` | Result sheets |
| `13 Output_Next Round Draws/` | Generated next-round draws (`.xlsx`) |
| `20 Database Backup/` | Auto-backups (after import, export, generate) |
| `80 Shared/` | Mirrored shared copies for the scoring team |

---

## Deployment

Push to `main` with changes under `rdms/**` → the **Deploy RDMS** GitHub Action
(`.github/workflows/deploy.yml`) builds with Node 22 + Vite and publishes to
GitHub Pages. A service worker (`rdms/public/sw.js`) caches the app shell; bump
`CACHE_NAME` when shipping a change that must evict stale clients.

---

## Notes

- This is a **live race-day application** — verify changes with `npm run build`
  and `node tests/smoke.mjs` before deploying, and avoid breaking core flows.
- Result/draw sheets are real OOXML xlsx content; next-round draws use the
  `.xlsx` extension, result sheets keep the `.xls` name (content is sniffed
  downstream).
