// node --test   (no dependencies)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), cp = require("child_process");

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "router-home-"));
process.env.SKILL_ROUTER_HOME = tmpHome;
const S = require("../skills/skill-router/scripts/session.js");
const SCRIPT = path.join(__dirname, "..", "skills", "skill-router", "scripts", "session.js");

test("every request's steps name known skills and conditions", () => {
  for (const r of S.DATA.requests) {
    for (const st of r.steps) {
      if (st.pr) continue;
      assert.ok(S.DATA.skills[st.s], `${r.id}: unknown skill ${st.s}`);
      if (st.cond) assert.ok(S.DATA.conds[st.cond], `${r.id}: unknown condition ${st.cond}`);
    }
  }
  assert.equal(S.DATA.requests.length, 23);
});

test("plan turns conditions off, skips and adds steps", () => {
  const p = S.buildPlan({ req: "bug", conds: ["tools"], skip: ["simplify"], add: ["context7@diagnosing-bugs:Fetch docs"] });
  const ids = p.steps.map(s => s.s);
  assert.equal(ids[ids.indexOf("diagnosing-bugs") + 1], "context7", "added step lands after its anchor");
  assert.equal(p.steps.find(s => s.s === "simplify").on, false, "skipped step is off");
  assert.equal(p.steps.find(s => s.s === "security-review").on, false, "auth condition off");
  assert.equal(p.steps.find(s => s.s === "graphify").on, true, "tools condition on");
  assert.equal(p.steps[p.steps.length - 1].gate, "oneway", "the PR step is a one-way door");
});

test("ticket plan appends the chosen branch's pipeline without a second router step", () => {
  const p = S.buildPlan({ req: "ticket", branch: "refactor", conds: [] });
  assert.equal(p.steps.filter(s => s.s === "skill-router").length, 1);
  assert.ok(p.steps.some(s => s.s === "codebase-design"));
});

test("mode changes gates", () => {
  const step = S.buildPlan({ req: "small", mode: "step" });
  assert.ok(step.steps.filter(s => s.on).every(s => s.gate), "step mode pauses everywhere");
  const plan = S.buildPlan({ req: "feature", mode: "plan", conds: [] });
  assert.equal(plan.steps.find(s => s.s === "to-spec").gate, "approve");
  const auto = S.buildPlan({ req: "feature", mode: "auto", conds: [] });
  assert.equal(auto.steps.find(s => s.s === "to-spec").gate, null);
});

test("advice: no previous task, no advice", () => {
  assert.equal(S.advise({ ctx: 500000, prev: null, req: "bug", related: false, planSteps: 4 }), null);
});
test("advice: hard stop at 150k", () => {
  assert.equal(S.advise({ ctx: 150000, prev: { task: "a" }, req: "small", related: true, planSteps: 3 }).verdict, "stop");
});
test("advice: small related task in a light session stays", () => {
  assert.equal(S.advise({ ctx: 20000, prev: { task: "a" }, req: "bug", related: true, planSteps: 6 }).verdict, "stay");
});
test("advice: big task goes to a new session", () => {
  assert.equal(S.advise({ ctx: 20000, prev: { task: "a" }, req: "feature", related: true, planSteps: 12 }).verdict, "new");
});
test("advice: related but heavy session compacts first", () => {
  assert.equal(S.advise({ ctx: 90000, prev: { task: "a" }, req: "bug", related: true, planSteps: 6 }).verdict, "compact");
});
test("advice: uncommitted previous work plus unrelated task means new session", () => {
  assert.equal(S.advise({ ctx: 10000, prev: { task: "a" }, dirty: true, req: "bug", related: false, planSteps: 5 }).verdict, "new");
});
test("advice: unrelated small task stays only while the session is light", () => {
  assert.equal(S.advise({ ctx: 20000, prev: { task: "a" }, req: "small", related: false, planSteps: 4 }).verdict, "stay");
  assert.equal(S.advise({ ctx: 45000, prev: { task: "a" }, req: "small", related: false, planSteps: 4 }).verdict, "new");
});

test("link round-trips and uses only letters and digits after #z", () => {
  const p = S.buildPlan({ req: "prready", conds: ["ui"] });
  const payload = S.payloadOf(p, { t: "Ünïcode task “quotes”", sid: "abc", ts: 1 });
  const url = S.linkOf(payload);
  assert.match(url.slice(url.indexOf("#")), /^#z[a-z2-7]+$/);
  assert.deepEqual(S.decodeLink(url), JSON.parse(JSON.stringify(payload)));
  assert.ok(url.length < 2000, "link stays under 2000 characters");
});

test("context size comes from the last main-thread reply's usage", () => {
  const f = path.join(tmpHome, "t.jsonl");
  const line = (o) => JSON.stringify(o) + "\n";
  fs.writeFileSync(f,
    line({ type: "user", message: { content: "fix the login bug please" } }) +
    line({ type: "assistant", message: { usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 } } }) +
    line({ type: "assistant", isSidechain: true, message: { usage: { input_tokens: 999999 } } }));
  assert.equal(S.contextTokens(f), 1110);
  assert.equal(S.guessName(f), "fix the login bug please");
});

test("hook prints one context line and never fails", () => {
  const env = { ...process.env }; delete env.CLAUDE_CODE_REMOTE_SDK_URL;
  const out = cp.execFileSync("node", [SCRIPT, "hook"], { input: JSON.stringify({ session_id: "s1", transcript_path: "/nope" }), env }).toString();
  assert.match(out, /^\[skill-router\] session s1 · context \? · tasks this session: 0/);
  const remote = cp.execFileSync("node", [SCRIPT, "hook"], { input: "{}", env: { ...env, CLAUDE_CODE_REMOTE_SDK_URL: "https://x/v1/code/sessions/cse_ABC123" } }).toString();
  assert.match(remote, /session session_ABC123/, "cloud sessions show the claude.ai session id");
  const bad = cp.execFileSync("node", [SCRIPT, "hook"], { input: "not json", env }).toString();
  assert.match(bad, /\[skill-router\]/);
});

test("install adds the hook once, keeps existing settings, writes a backup", () => {
  const settings = path.join(tmpHome, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ theme: "dark", skillOverrides: { tdd: "off" } }));
  fs.mkdirSync(path.join(tmpHome, ".claude", "skills", "tdd"), { recursive: true });
  fs.mkdirSync(path.join(tmpHome, ".claude", "skills", "pr"), { recursive: true });
  const env = { ...process.env, SKILL_ROUTER_HOME: tmpHome };
  cp.execFileSync("node", [SCRIPT, "install"], { env });
  cp.execFileSync("node", [SCRIPT, "install"], { env });
  const s = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.equal(s.theme, "dark");
  assert.equal(s.skillOverrides.tdd, "off", "user's own choice kept");
  assert.equal(s.skillOverrides.pr, "name-only");
  assert.equal(s.skillOverrides["skill-router"], "on");
  assert.equal(s.hooks.UserPromptSubmit.length, 1, "hook added once");
  assert.ok(fs.existsSync(settings + ".bak-skill-router"));
});
