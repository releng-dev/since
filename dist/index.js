// --- shared: identical in every action, checked by test/actions.test.mjs ---
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const env = process.env;

class Fail extends Error {}
const fail = (message) => {
  throw new Fail(message);
};
const escapeCommand = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

// GitHub passes input "keep-days" as INPUT_KEEP-DAYS: upper-cased, dashes kept.
const input = (name, fallback = "") => (env[`INPUT_${name.toUpperCase()}`] ?? "").trim() || fallback;

const setOutput = (name, value) => {
  const text = String(value);
  if (!env.GITHUB_OUTPUT) {
    console.log(`output ${name}=${text}`);
    return;
  }
  const delimiter = `ghadelimiter_${randomUUID()}`;
  appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
};

// Hosted Releng.dev. A team that runs its own server names it with RELENG_URL or the server input.
const HOSTED_URL = "https://api.releng.dev";

const serverUrl = () => (env.RELENG_URL || input("server") || HOSTED_URL).replace(/\/+$/, "");

// The job's OIDC token, audience "releng". Never printed; masked in the log.
const getToken = async () => {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    fail("This job can't get an OIDC token. Add `permissions: id-token: write` to the job (or the workflow).");
  }
  const url = new URL(requestUrl);
  url.searchParams.set("audience", "releng");
  const res = await fetch(url, { headers: { authorization: `Bearer ${requestToken}` } });
  if (!res.ok) fail(`GitHub would not give an OIDC token (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const { value } = await res.json();
  if (!value) fail("GitHub answered the OIDC request without a token.");
  console.log(`::add-mask::${value}`);
  return value;
};

// When Releng.dev is down or failing, re-running the job is how the run recovers.
const AGAIN = "Re-run this job once Releng.dev is back: https://releng.dev/docs#down";

// Calls Releng.dev's runner API. Fails on any status not in `allow`.
const call = async (method, path, { json, body, query, allow = [] } = {}) => {
  const base = serverUrl();
  const token = await getToken();
  const url = new URL(`${base}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) if (v) url.searchParams.set(k, v);
  const headers = { authorization: `Bearer ${token}` };
  if (json !== undefined) headers["content-type"] = "application/json";
  let res;
  try {
    res = await fetch(url, { method, headers, body: json !== undefined ? JSON.stringify(json) : body });
  } catch (e) {
    fail(`Could not reach Releng.dev at ${base}: ${e.cause?.message ?? e.message}. ${AGAIN}`);
  }
  if (res.ok || allow.includes(res.status)) return res;
  const text = (await res.text()).slice(0, 500);
  let message = text;
  try {
    const parsed = JSON.parse(text);
    message = parsed.error ?? parsed.message ?? text;
  } catch {}
  const down = res.status >= 500 ? ` ${AGAIN}` : "";
  fail(`Releng.dev answered ${res.status} on ${method} ${path}: ${message || res.statusText}${down}`);
};

const run = (main) =>
  main().catch((e) => {
    console.log(`::error::${escapeCommand(e instanceof Fail ? e.message : `Unexpected failure: ${e.stack ?? e}`)}`);
    process.exit(1);
  });
// --- end shared ---

import { spawnSync } from "node:child_process";

run(async () => {
  const res = await call("POST", "/runner/v1/since", { json: {} });
  const answer = await res.json();
  const sha = String(answer.sha ?? "");
  if (sha && !/^[0-9a-f]{40}$/.test(sha)) fail(`Releng.dev answered with ${sha}, which isn't a commit.`);
  // The tool compares with that commit, so the checkout needs it: actions/checkout fetches one
  // commit unless fetch-depth says otherwise.
  if (sha) {
    const git = spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`]);
    if (git.status !== 0 && !git.error)
      fail(`The checkout doesn't have ${sha.slice(0, 7)}, the commit to compare with. Check out with fetch-depth: 0.`);
  }
  if (sha) console.log(`Checks what changed since ${answer.version || sha.slice(0, 7)} (${sha.slice(0, 7)}).`);
  else console.log(`Runs everything: ${answer.why || "Releng.dev gave no commit to compare with"}.`);
  setOutput("sha", sha);
  setOutput("version", sha ? String(answer.version ?? "") : "");
  setOutput("full", sha ? "false" : "true");
});
