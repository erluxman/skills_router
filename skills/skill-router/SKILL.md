---
name: skill-router
description: MASTER SKILL. Use FIRST, before reading code or changing anything, for every software engineering request (bug, feature, refactor, ticket or issue, "make the PR ready", review comments, CI, release, incident, migration, dependency upgrade, performance, security, UI, "should we", "explain this codebase", "rate it", wrap up). It shows the user a preview link of the exact plan (which skills, in what order, what each produces), advises whether a new goal belongs in this session, and runs the plan one skill at a time.
---

# skill-router (master skill)

Skip only for chat that isn't engineering work, or a one-line factual answer. The `[skill-router]` line a hook adds to
each prompt gives the session id, context size and tasks so far; use it.

`S` below means `node "${CLAUDE_SKILL_DIR}/scripts/session.js"`.

## 1. Before any work: plan, preview, confirm

1. **Same goal or new goal?** A new goal is a different bug, ticket, feature or area. Follow-ups on the current goal
   (fix the review comment, tweak the same fix, make *this* PR ready) are the same goal: no session advice, no new task.
2. **Ticket or issue?** (`#123`, an issue link, pasted ticket text) Read it all (body, labels, comments, linked PRs) and
   look at the code it names. Guess the work type from the evidence.
3. **Pick the request** (`--req`): `ticket` (with `--branch` = the type it turns out to be), `prready`, `bug`, `flaky`,
   `small`, `feature`, `epic`, `refactor`, `slow`, `security`, `migration`, `deps`, `ci`, `review`, `release`, `incident`,
   `question`, `ui`, `onboard`, `rate`, `setup`, `upkeep`, `end`.
4. **Conditions** (`--conds`, comma list) from a cheap look at the ticket and `git diff --stat`, never a deep read:
   `tools` (graphify / context7 / agent-lsp installed), `auth`, `ui`, `schema`, `hot`, `logic` (parsers, money, dates),
   `contract` (public API), `unclear` (bug state unclear), `human` (needs a decision only a person can make).
5. **Make it exact for this task**: `--skip a,b` for steps that don't apply, `--add "skill@after:what it does"` for extra
   ones (separate several with `;`). Mode `--mode auto|plan|step` (default `auto`; use `plan` for features, migrations,
   auth and payments).
6. **Session name**: in a cloud session call the `get_session` tool (claude-code-remote) and pass its title as `--name`;
   locally pass the session's name if you know it, else omit (the script guesses).
7. **Run**: `S plan --req … --conds … --task "<one line>" --name "…" --new-goal yes|no --related yes|no`.
   It prints the preview link, the path, the session line, the advice and the numbered steps.
8. **Show the user** the link, the one-line path, and the advice line, word for word. Then:
   - Advice **STOP**: do not start. Offer a new session (below). Continue here only if the user says "continue here".
   - Advice **NEW**: recommend a new session; start here only if the user chooses to.
   - Advice **COMPACT**: suggest `/compact` first, then continue.
   - Advice **STAY**, or no advice: go on.
   - "Wait for the user's OK" printed: ask with AskUserQuestion (recommended option first: start / change the plan /
     new session), and do nothing until answered. "Tiny plan": say you're starting and start.
9. **Record**: `S start --req <id> --task "<one line>"` when work begins; `S done` when the goal is finished.

**New session, when chosen**: write a 5-line handoff (goal, branch, files, state, next step). In a cloud session offer to
start it with the `create_session` tool (claude-code-remote) with that handoff as the prompt; locally give the command
`claude "<handoff>"`. Do not start the new goal here.

## 2. Running the plan

- Follow the printed steps in order. Each step names a skill. Load it only when its step starts:
  installed → the Skill tool; `[fetch: …]` → run that command and follow the SKILL.md it prints, for that step only;
  `builtin` → the built-in skill or command; `tool` → use the tool if installed, else skip and say so.
  Never install anything without the user's yes.
- Steps marked "asks you", "one-way door" or "waits for approval" stop for the user. "pauses after": report and wait.
- **pr-ready steps** (the run from the baseline check to `pr`) are limited to the diff. Commit each kind of change
  separately (`refactor:`, `test:`, `fix:`); end with a table: step | result | evidence.
- Never drop: a red test before a fix, `verification-before-completion` before saying "done", `code-review`, and
  `security-review` / `migration-architect` when their conditions hold.
- If the work changes shape (a small change grows, a bug turns out to be a missing feature), run `S plan` again and show
  the new link.

## 3. Context hygiene

- Skills over ~10 KB and steps that read a lot (research, reviews of large diffs, audits, profiling, onboarding) run in
  a subagent that loads the skill there and returns at most 300 words plus file paths.
- Results go to files (spec, ADR, research note, plans); the chat gets the path.
- Review the diff, not whole files; read line ranges; prefer `graphify query` / LSP over grep plus full reads.
- More than 8 steps: keep `.claude/progress/<branch>.md` (one line per finished step: step, result, evidence) so a
  compaction or a new session can resume. Fold it into the PR body at the end, then delete it.
- End every plan with: `Context: N skills in main, M in subagents; progress file yes/no`.
