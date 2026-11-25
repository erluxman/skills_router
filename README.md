# skills_router

Agent skills: writing voice, de-AI rules, and a router for when to load which skill.

## skill-router: the master skill

Before Claude does any engineering work, `skill-router`:

1. classifies the request (23 kinds, from "fix a bug" to "make the PR ready" to "work on #123"),
2. builds the **exact plan**: which skills run, in what order, what each produces, where it stops for you,
3. gives you a **preview link** that draws that plan as a flow diagram, with the session that fired it (name and id),
4. when the session already worked on another goal, **advises** stay / compact / new session with token numbers,
   and **stops** above 150k tokens of context unless you say "continue here",
5. waits for your OK (plans of 5 steps or fewer just start), then runs the plan one skill at a time. Each skill
   loads only when its step starts: installed skills by name, the rest fetched with `npx skills use`, nothing installed
   without your yes.

Preview page: <https://claude.ai/artifact/6UmcjcLjprJDdhoyndDGd2> (its History tab lists every plan you've opened).

### Install on your computer (all repos)

```bash
npx -y skills@latest add erluxman/skills_router -g -a claude-code -y -s skill-router
```
```bash
node ~/.claude/skills/skill-router/scripts/session.js install
```

The second command adds a `UserPromptSubmit` hook to `~/.claude/settings.json` (one short context line per prompt:
session id, context size, tasks so far) and sets installed skills to `name-only` so only the router's description is
always in context. It keeps your existing settings and writes `settings.json.bak-skill-router` first.

### Install in cloud sessions (every environment)

Add these two lines to each environment's setup script (claude.ai → Code → environment settings):

```bash
npx -y skills@latest add erluxman/skills_router -g -a claude-code -y -s skill-router
node ~/.claude/skills/skill-router/scripts/session.js install
```

Only the router is installed (a few seconds). Every other skill is fetched on demand when a step needs it.

### Try it

Start a session and say "make the PR ready", "fix: checkout total is wrong for discounts" or "work on #12".
You get the link and the path first. Then, in the same session, ask for an unrelated fix to see the session advice.

### How it fits together

| File | What it is |
|---|---|
| `skills/skill-router/SKILL.md` | The master skill (kept short: it loads on every engineering task) |
| `skills/skill-router/data/pipelines.json` | The one source of truth: 23 requests, 50 skills, their steps, conditions, gates |
| `skills/skill-router/scripts/session.js` | `plan` (exact plan + link + advice), `start` / `done`, `hook`, `install`, `status` |
| `preview/page.html` | The preview page; `node preview/build.js` embeds the data into `preview/dist/index.html` |
| `docs/DECISIONS.md` | What was decided and why |
| `test/` | `npm test`: advice rules, plans, link round-trip, hook, install |

Settings you can change with environment variables: `SKILL_ROUTER_STOP_AT` (default 150000 tokens),
`SKILL_ROUTER_PREVIEW_URL` (the page the links open).
