# DEPRECATED — Legacy Alive Dashboard

This directory (`alive/dashboard/`) contains the original single-persona visualization dashboard built early in the project. It is **no longer actively maintained** as of 2026-04-24.

## Use instead

The ops/delivery UI has been replaced by:

- **Frontend:** `/Users/halyu/Documents/Code/missv-ops-web/` — React 19 + Vite 8 + TanStack Query. Run via `npm run dev` (default port 5173).
- **Backend API:** `/Users/halyu/Documents/Code/Alive/alive/api-server/` — Express + tsx. Run via `npm run dev` (default port 3001).

The new stack supplies cached LLM runs, cron-status integration, review queue controls, competitor health badges, trend backfill from the discovery pool, and full intel/analytics/strategy panels.

## When to look here

Only for git history or salvaging UI ideas. Do not ship new operator features here.
