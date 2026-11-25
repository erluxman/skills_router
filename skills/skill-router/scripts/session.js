#!/usr/bin/env node
// skill-router helper. No dependencies (node 18+).
//   plan    build the exact plan for a request, the preview link, and same-session advice
//   start   record that the plan was approved and work began      done   mark the current task finished
//   hook    UserPromptSubmit hook: one short context line per prompt
//   install add the hook and skillOverrides to ~/.claude/settings.json (backup kept)
//   status  show this session's id, name, context size and tasks
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), zlib = require("zlib"), cp = require("child_process");

const SKILL_DIR = path.resolve(__dirname, "..");
const DATA = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, "data", "pipelines.json"), "utf8"));
const PREVIEW_URL = process.env.SKILL_ROUTER_PREVIEW_URL || "https://claude.ai/artifact/6UmcjcLjprJDdhoyndDGd2";
const STOP_AT = Number(process.env.SKILL_ROUTER_STOP_AT) || 150000;   // hard stop for a second goal in one session
const COMPACT_AT = 60000;                                               // above this, a related small task: compact first
const TINY_STEPS = 5;                                                   // plans this short don't wait for an OK
const FRESH_START = 6000;                                               // rough tokens a new session starts with
const HOME = () => process.env.SKILL_ROUTER_HOME || os.homedir();
const BIG = new Set(["feature", "epic", "migration", "refactor", "security", "deps", "ui", "incident", "onboard", "upkeep", "setup"]);

/* ---------------- args ---------------- */
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2), v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) o[k] = true; else { o[k] = v; i++; }
    } else o._.push(a);
  }
  return o;
}
const list = v => (typeof v === "string" ? v.split(",").map(s => s.trim()).filter(Boolean) : []);
const yes = v => v === true || /^(y|yes|true|1)$/i.test(String(v || ""));

/* ---------------- session ---------------- */
function sessionInfo(hookInput = {}) {
  const env = process.env;
  const id = hookInput.session_id || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || null;
  const m = /\/sessions\/(?:cse_|session_)([A-Za-z0-9]+)/.exec(env.CLAUDE_CODE_REMOTE_SDK_URL || "");
  const remoteId = m ? "session_" + m[1] : null;
  const transcript = hookInput.transcript_path || findTranscript(id);
  return { id, remoteId, transcript };
}
function findTranscript(id) {
  if (!id) return null;
  const root = path.join(HOME(), ".claude", "projects");
  try {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, id + ".jsonl");
      if (fs.existsSync(f)) return f;
    }
  } catch (e) { /* no projects dir */ }
  return null;
}
function readTail(file, bytes) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - bytes), len = size - start;
    const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, start);
    return buf.toString("utf8");
  } finally { fs.closeSync(fd); }
}
/** Current context size = the last main-thread reply's input + cache tokens, as the API reported them. */
function contextTokens(transcript) {
  if (!transcript || !fs.existsSync(transcript)) return null;
  const lines = readTail(transcript, 4 * 1024 * 1024).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes('"usage"') || !l.includes('"assistant"')) continue;
    let d; try { d = JSON.parse(l); } catch (e) { continue; }
    if (d.type !== "assistant" || d.isSidechain) continue;
    const u = d.message && d.message.usage;
    if (u) return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  }
  return null;
}
/** Best local guess at the session's name: a custom title or summary, else the first prompt. */
function guessName(transcript) {
  if (!transcript || !fs.existsSync(transcript)) return null;
  const size = fs.statSync(transcript).size;
  const text = size > 30 * 1024 * 1024 ? readTail(transcript, 8 * 1024 * 1024) : fs.readFileSync(transcript, "utf8");
  let title = null, first = null;
  for (const l of text.split("\n")) {
    if (!l) continue;
    if (l.includes('"custom-title"') || l.includes('"summary"') || l.includes('"ai-title"')) {
      try { const d = JSON.parse(l); title = d.customTitle || d.title || d.aiTitle || d.summary || title; } catch (e) { /* skip */ }
    } else if (!first && l.includes('"type":"user"')) {
      try {
        const d = JSON.parse(l), c = d.message && d.message.content;
        const t = typeof c === "string" ? c : Array.isArray(c) ? (c.find(x => x.type === "text") || {}).text : null;
        if (t && !t.startsWith("<")) first = t;
      } catch (e) { /* skip */ }
    }
  }
  const n = (title || first || "").replace(/\s+/g, " ").trim();
  return n ? (n.length > 60 ? n.slice(0, 57) + "…" : n) : null;
}
function gitDirty(cwd) {
  try { return cp.execSync("git status --porcelain", { cwd: cwd || process.cwd(), stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString().trim().length > 0; }
  catch (e) { return null; }
}

/* ---------------- state (one file per session) ---------------- */
const stateFile = id => path.join(HOME(), ".claude", "skill-router", "state", (id || "unknown") + ".json");
function loadState(id) { try { return JSON.parse(fs.readFileSync(stateFile(id), "utf8")); } catch (e) { return { tasks: [] }; } }
function saveState(id, s) { const f = stateFile(id); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(s, null, 1)); }

/* ---------------- plan ---------------- */
function findReq(id) {
  const r = DATA.requests.find(x => x.id === id);
  if (!r) throw new Error(`unknown request "${id}". Known: ${DATA.requests.map(x => x.id).join(", ")}`);
  return r;
}
function installedSkills() {
  try { return new Set(fs.readdirSync(path.join(HOME(), ".claude", "skills"))); } catch (e) { return new Set(); }
}
function loadOf(skill, installed) {
  const k = DATA.skills[skill];
  if (installed.has(skill)) return "installed";
  if (!k) return "custom";
  if (k.load === "installed") return "ondemand";        // listed as core, but not installed here: fetch on demand
  return k.load;
}
/**
 * Build the exact plan. opts: req, branch (for ticket), conds (array), mode, skip (array of skills), add (array of
 * "skill@after:does text" strings), task. Returns steps with on/off, gate and load, as Claude will run them.
 */
function buildPlan(opts) {
  const r = findReq(opts.req);
  let raw = r.steps.slice();
  if (r.id === "ticket") {
    const b = findReq(opts.branch || "bug");
    raw = raw.concat(b.steps.filter(s => s.s !== "skill-router"));
  }
  const conds = new Set(opts.conds || []), skip = new Set(opts.skip || []), installed = installedSkills();
  let steps = [];
  for (const s of raw) {
    if (s.pr) DATA.prReady.forEach(p => steps.push({ ...p, pr: true }));
    else steps.push({ ...s });
  }
  for (const a of opts.add || []) {                    // "skill@after:does"
    const m = /^([\w-]+)(?:@([\w-]+))?(?::(.*))?$/.exec(a.trim());
    if (!m) throw new Error(`bad --add "${a}" (use skill@after:what it does)`);
    const st = { s: m[1], does: m[3] || "Added for this task", out: "", custom: true };
    const at = m[2] ? steps.findIndex(x => x.s === m[2]) : -1;
    if (at >= 0) steps.splice(at + 1, 0, st); else steps.splice(Math.max(steps.length - 1, 0), 0, st);
  }
  const mode = opts.mode || "auto";
  steps = steps.map(s => {
    const off = s.cond && !conds.has(s.cond) ? "condition off: " + (DATA.conds[s.cond] || s.cond) : skip.has(s.s) ? "skipped for this task" : null;
    let gate = null;
    if (!off) {
      if (s.gate === "always") gate = "ask";
      else if (s.gate === "oneway") gate = "oneway";
      else if (s.gate === "plan" && mode !== "auto") gate = "approve";
      else if (mode === "step") gate = "pause";
    }
    return { ...s, on: !off, off, gate, load: loadOf(s.s, installed) };
  });
  return { req: r, steps, mode, conds: [...conds] };
}

/* ---------------- same-session advice ---------------- */
/**
 * Only for a NEW GOAL in a session that already worked on one. Verdicts: stay | compact | new | stop.
 * stop = refuse to start until the user says "continue here".
 */
function advise({ ctx, prev, dirty, req, related, planSteps }) {
  if (!prev) return null;
  const big = BIG.has(req) || planSteps > 10;
  const k = t => (t || 0) >= 1e6 ? ((t || 0) / 1e6).toFixed(1) + "M" : Math.round((t || 0) / 1000) + "k";
  const turns = big ? 40 : 15;
  const costs = { stay: ctx, fresh: FRESH_START, stayTotal: ctx != null ? ctx * turns : null, freshTotal: FRESH_START * turns };
  const base = { ctx, prev, dirty, costs, turns };
  if (ctx == null) return { ...base, verdict: big || !related ? "new" : "stay", why: "Context size unknown (no transcript found); judged on task size and relatedness only." };
  if (ctx >= STOP_AT) return { ...base, verdict: "stop", why: `This session already holds ${k(ctx)} tokens (limit ${k(STOP_AT)}). Every turn re-reads all of it, and quality drops in long contexts. Start a new session; continue here only if you say "continue here".` };
  if (dirty && !related) return { ...base, verdict: "new", why: `The last task (“${prev.task}”) has uncommitted changes; an unrelated change here would mix into the same diff. Commit it, then start a new session (or a worktree).` };
  if (big) return { ...base, verdict: "new", why: `A ${req} is big (${planSteps} steps, ~${turns} turns); starting at ${k(FRESH_START)} instead of ${k(ctx)} saves about ${k((ctx - FRESH_START) * turns)} tokens of re-reading.` };
  if (ctx >= COMPACT_AT) return { ...base, verdict: related ? "compact" : "new", why: related
      ? `Related and small, but the session holds ${k(ctx)}. Run /compact first, then continue here: you keep what you learned, drop the bulk.`
      : `Unrelated, and the session holds ${k(ctx)}: a new session is cheaper and cleaner.` };
  if (related) return { ...base, verdict: "stay", why: `Small and related, and the session holds only ${k(ctx)}: the files are already in context (and cached), so staying is cheaper than re-reading them.` };
  return ctx < 30000
    ? { ...base, verdict: "stay", why: `Unrelated but small, and the session is light (${k(ctx)}). Staying is fine.` }
    : { ...base, verdict: "new", why: `Unrelated, and ${k(ctx)} of the last task's context would ride along for nothing. A new session starts at ~${k(FRESH_START)}.` };
}

/* ---------------- link ---------------- */
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
function b32(buf) {
  let bits = 0, val = 0, out = "";
  for (const byte of buf) { val = (val << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function unb32(s) {
  let bits = 0, val = 0; const out = [];
  for (const ch of s) { const i = B32.indexOf(ch); if (i < 0) throw new Error("bad char"); val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
const GATE = { ask: 1, oneway: 2, approve: 3, pause: 4 };
const LOADCODE = { builtin: "b", installed: "i", ondemand: "o", tool: "t", yours: "y", custom: "c" };
function payloadOf(plan, extra) {
  const st = plan.steps.map(s => {
    const row = [s.s, s.on ? 1 : 0, s.gate ? GATE[s.gate] : 0, LOADCODE[s.load] || "c"];
    if (s.custom) row.push(s.does, s.out || "");
    return row;
  });
  return {
    v: 1, r: plan.req.id, m: plan.mode, c: plan.conds, st,
    ...extra,
  };
}
function linkOf(payload) { return PREVIEW_URL + "#z" + b32(zlib.deflateRawSync(Buffer.from(JSON.stringify(payload)), { level: 9 })); }
function decodeLink(url) { const h = url.slice(url.indexOf("#z") + 2); return JSON.parse(zlib.inflateRawSync(unb32(h)).toString("utf8")); }

/* ---------------- commands ---------------- */
function readStdin() { try { return fs.readFileSync(0, "utf8"); } catch (e) { return ""; } }
const k = t => (t == null ? "?" : t >= 1e6 ? (t / 1e6).toFixed(1) + "M" : Math.round(t / 1000) + "k");

function cmdPlan(a) {
  const si = sessionInfo();
  const ctx = contextTokens(si.transcript);
  const state = loadState(si.id);
  const open = state.tasks.filter(t => !t.done);
  const prev = state.tasks[state.tasks.length - 1] || null;
  const plan = buildPlan({ req: a.req, branch: a.branch, conds: list(a.conds), mode: a.mode, skip: list(a.skip), add: a.add ? [].concat(a.add).flatMap(x => String(x).split(";")) : [] });
  const on = plan.steps.filter(s => s.on);
  const newGoal = a["new-goal"] === undefined ? !!prev : yes(a["new-goal"]);
  const adv = newGoal ? advise({ ctx, prev, dirty: gitDirty(), req: plan.req.id, related: yes(a.related), planSteps: on.length }) : null;
  const wait = on.length > TINY_STEPS || !!adv;
  const name = a.name && a.name !== true ? a.name : guessName(si.transcript);
  const payload = payloadOf(plan, {
    b: plan.req.id === "ticket" ? (a.branch || "bug") : undefined,
    t: a.task && a.task !== true ? String(a.task).slice(0, 140) : undefined,
    sid: si.id || undefined, rid: si.remoteId || undefined, sn: name || undefined,
    ts: Math.floor(Date.now() / 1000), ctx: ctx == null ? undefined : ctx,
    n: state.tasks.length + (newGoal || !prev ? 1 : 0),
    a: adv ? { v: adv.verdict, y: adv.why, p: prev && prev.task, d: adv.dirty ? 1 : 0, s: adv.costs.stayTotal, f: adv.costs.freshTotal, u: adv.turns } : undefined,
    w: wait ? 1 : 0,
  });
  const url = linkOf(payload);
  if (a.json) { process.stdout.write(JSON.stringify({ url, payload, plan: plan.steps, advice: adv, wait }, null, 1) + "\n"); return; }
  const G = { ask: "asks you", oneway: "one-way door: asks first", approve: "waits for approval", pause: "pauses after" };
  const out = [];
  out.push(`Preview: ${url}`);
  out.push(`Path (${plan.req.title}${plan.req.id === "ticket" ? " → " + findReq(a.branch || "bug").title : ""}, ${on.length} steps, ${plan.mode}): ${collapse(on.map(s => s.s)).join(" → ")}`);
  out.push(`Session: ${name || "unnamed"} · ${si.remoteId || si.id || "unknown id"} · context ${k(ctx)} · ${open.length} open / ${state.tasks.length} tasks so far`);
  if (adv) out.push(`Advice: ${adv.verdict.toUpperCase()}. ${adv.why}`);
  out.push(wait ? "Wait for the user's OK before starting." : "Tiny plan: show it and start.");
  out.push("Steps:");
  let i = 0; const shown = new Set();
  for (const s of plan.steps) {
    const src = DATA.skills[s.s] && DATA.skills[s.s].source;
    const fetch = s.on && s.load === "ondemand" && src && src.includes("/") && !shown.has(s.s) ? ` [fetch: npx -y skills@latest use ${src}@${s.s}]` : "";
    if (fetch) shown.add(s.s);
    out.push(s.on ? `${String(++i).padStart(2)}. ${s.s} [${s.load}]${s.gate ? " (" + G[s.gate] + ")" : ""}: ${s.does}${s.out ? " → " + s.out : ""}${fetch}`
                  : `  -  ${s.s}: skipped (${s.off})`);
  }
  process.stdout.write(out.join("\n") + "\n");
}
function collapse(ids) { return ids.filter((x, i) => x !== ids[i - 1]); }

function cmdStart(a) {
  const si = sessionInfo(), s = loadState(si.id);
  s.tasks.push({ req: a.req || null, task: a.task && a.task !== true ? String(a.task) : null, ts: Date.now(), ctx: contextTokens(si.transcript), done: false });
  saveState(si.id, s);
  process.stdout.write(`Recorded task ${s.tasks.length} for session ${si.id}.\n`);
}
function cmdDone() {
  const si = sessionInfo(), s = loadState(si.id), t = s.tasks[s.tasks.length - 1];
  if (t) { t.done = true; t.doneTs = Date.now(); saveState(si.id, s); }
  process.stdout.write(t ? `Marked “${t.task}” done.\n` : "No task recorded.\n");
}
function cmdStatus() {
  const si = sessionInfo(), s = loadState(si.id), ctx = contextTokens(si.transcript);
  process.stdout.write(JSON.stringify({ ...si, name: guessName(si.transcript), context: ctx, tasks: s.tasks }, null, 1) + "\n");
}
function cmdHook() {
  // Never block or fail the user's prompt: any error ends silently.
  try {
    let input = {}; try { input = JSON.parse(readStdin() || "{}"); } catch (e) { /* not JSON */ }
    const si = sessionInfo(input), s = loadState(si.id), ctx = contextTokens(si.transcript);
    const last = s.tasks[s.tasks.length - 1];
    const parts = [`[skill-router] session ${si.remoteId || si.id || "?"} · context ${k(ctx)} · tasks this session: ${s.tasks.length}`];
    if (last) parts.push(`last: ${last.req || "?"} “${(last.task || "").slice(0, 50)}”${last.done ? " (done)" : " (open)"}`);
    if (ctx != null && ctx >= STOP_AT) parts.push(`over the ${k(STOP_AT)} limit`);
    parts.push("If this prompt starts engineering work or a new goal, use the skill-router skill first (preview link + session advice) before any work.");
    process.stdout.write(parts.join(" · ") + "\n");
  } catch (e) { /* silent */ }
}
function cmdInstall(a) {
  const settings = path.join(HOME(), ".claude", "settings.json");
  let s = {}, raw = null;
  if (fs.existsSync(settings)) {
    raw = fs.readFileSync(settings, "utf8");
    try { s = JSON.parse(raw || "{}"); } catch (e) { process.stderr.write(`${settings} is not valid JSON; fix it first.\n`); process.exit(1); }
  }
  const script = path.join(SKILL_DIR, "scripts", "session.js");
  const cmd = `node "${script}" hook`;
  s.hooks = s.hooks || {};
  const ups = s.hooks.UserPromptSubmit = s.hooks.UserPromptSubmit || [];
  const has = ups.some(g => (g.hooks || []).some(h => String(h.command || "").includes("skill-router/scripts/session.js")));
  if (!has) ups.push({ hooks: [{ type: "command", command: cmd, timeout: 10 }] });
  const o = s.skillOverrides = s.skillOverrides || {};
  o["skill-router"] = "on";
  let named = 0;
  for (const d of installedSkills()) if (d !== "skill-router" && DATA.skills[d] && !(d in o)) { o[d] = "name-only"; named++; }
  if (a["dry-run"]) { process.stdout.write(JSON.stringify({ settings, hookAdded: !has, nameOnly: named }, null, 1) + "\n"); return; }
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  if (raw !== null) fs.writeFileSync(settings + ".bak-skill-router", raw);
  fs.writeFileSync(settings, JSON.stringify(s, null, 2) + "\n");
  process.stdout.write(`skill-router: hook ${has ? "already present" : "added"}, ${named} skills set to name-only, in ${settings}${raw !== null ? " (backup: settings.json.bak-skill-router)" : ""}.\n`);
}

module.exports = { buildPlan, advise, payloadOf, linkOf, decodeLink, b32, unb32, contextTokens, guessName, sessionInfo, DATA };

if (require.main === module) {
  const a = parseArgs(process.argv.slice(2)), cmd = a._[0];
  try {
    ({ plan: cmdPlan, start: cmdStart, done: cmdDone, hook: cmdHook, install: cmdInstall, status: cmdStatus }[cmd] ||
      (() => { process.stdout.write("usage: session.js plan|start|done|hook|install|status [options]\n  plan --req <id> [--branch <id>] [--conds a,b] [--mode auto|plan|step] [--skip s1,s2] [--add 'skill@after:does'] [--task '...'] [--name '...'] [--new-goal yes|no] [--related yes|no] [--json]\n"); }))(a);
  } catch (e) { process.stderr.write("skill-router: " + e.message + "\n"); process.exit(2); }
}
