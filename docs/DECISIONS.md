# Decisions: skill-router as the master skill

Recorded from the grilling session on 2026-11-25. Each line: the decision, then why.

## Scope and rollout
- **Active everywhere**: every repo, local and cloud. Lives in this public repo so any machine or cloud setup script can
  install it with `npx skills add`. (Cloud containers start fresh; a private repo can't be fetched by a setup script.)
- **Cloud installs the router only.** Other skills are fetched on demand (`npx skills use`) when a step needs them, so
  containers start in seconds and nothing unused is loaded.
- **Name: `skill-router`.**

## Before work starts
- **Always show the preview link** of the exact plan before any work.
- **Wait for the user's OK**, except tiny plans (5 steps or fewer), which are shown and started.
- **The link shows the exact plan** for this task (skipped and added steps, detected conditions, gates), not the stock
  pipeline, so what you see is what runs.
- **The link names the session** that fired it: name and id (the claude.ai `session_…` id in the cloud, the local
  session id otherwise).
- **No query strings.** claude.ai artifact links pass only a plain `#name` to the page, so the plan travels as one
  compressed, letters-and-digits fragment: `#z…` (deflate, then base32). Links stay under ~1,000 characters.

## Two goals in one session
- **A "second task" means the goal changed**: a different bug, ticket, feature or area. Follow-ups on the same goal
  (review comments, the same fix, making this PR ready) are not a new task.
- **Always recommend** for a new goal: stay, compact then stay, or a new session, with token numbers.
- **Hard stop at 150k tokens** of context: don't start the new goal unless the user says "continue here".
- **Rules** (`session.js advise`, tested in `test/session.test.js`):
  stop at ≥150k · new if the last task has uncommitted changes and this one is unrelated · new if the task is big
  (feature, epic, migration, refactor, security, deps, UI, incident, onboarding, setup, or more than 10 steps) ·
  between 60k and 150k: compact if related, else new · under 60k: stay if related; if unrelated, stay only under 30k.
- **Context size is measured, not guessed**: the last reply's input + cache tokens from the session transcript.
- Why staying can be right: two small related fixes in a warm session reuse files already in context (and cached).

## History
- **Every fired plan is logged** in the preview page's shared database when its link is opened: time, session name
  and id, task, request, advice, step count, and the link to reopen it. The page writes the row, so it works from any
  session without extra tools.

## Design choices (made while building)
- **One source of truth**: `data/pipelines.json` feeds both the planner script and the preview page.
- **The master skill stays small** (it loads on every engineering task); the detail lives in the script's output.
- **Never install without a yes**: a skill runs with the agent's full permissions.
