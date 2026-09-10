// `remote doctor`: checks and, with --fix, installs or signs in everything an
// engineer needs for remote mode, so Claude can do it instead of a README.
// Nothing here needs sudo: the GitHub CLI comes from Homebrew or winget when
// available, the Vapi CLI installer writes to ~/.vapi, GitHub sign-in uses the
// device flow (a one-time code relayed to the engineer), the repository
// invitation is accepted through the API, and the Vapi sign-in is the
// dashboard handoff. Anything that cannot be fixed is reported with the exact
// step left for a human.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as common from "./common.mjs";
import { LabError, log } from "./common.mjs";
import * as keyWrap from "./key_wrap.mjs";
import * as vapiCli from "./vapi_cli.mjs";

export const MIN_NODE_MAJOR = 22;

// ------------------------------------------------------------ pure helpers
export function parseRepoFromRemote(url) {
  const match = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url ?? "").trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

export function findInvitation(invitations, repo) {
  return (invitations ?? []).find((invitation) => String(invitation?.repository?.full_name ?? "").toLowerCase() === repo.toLowerCase()) ?? null;
}

export function nodeVersionOk(version = process.versions.node, minimum = MIN_NODE_MAJOR) {
  return Number(String(version).split(".")[0]) >= minimum;
}

/** Release asset of the GitHub CLI for this machine, e.g. gh_2.60.0_macOS_arm64.zip. */
export function ghAssetName(version, platform = process.platform, arch = process.arch) {
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : null;
  if (!cpu) return null;
  if (platform === "darwin") return `gh_${version}_macOS_${cpu}.zip`;
  if (platform === "linux") return `gh_${version}_linux_${cpu}.tar.gz`;
  return null;
}

// ------------------------------------------------------------ probes
function commandOk(command, args) {
  const result = spawnSync(command, args, { stdio: "ignore", timeout: 15_000 });
  return !result.error && result.status === 0;
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      const hit = findFile(path, name);
      if (hit) return hit;
    } else if (entry === name) {
      return path;
    }
  }
  return null;
}

/** Installs gh from the GitHub release into ~/.local/bin when no package manager can. */
async function downloadGh() {
  const release = await (await fetch("https://api.github.com/repos/cli/cli/releases/latest", { headers: { accept: "application/vnd.github+json", "user-agent": common.USER_AGENT }, signal: AbortSignal.timeout(30_000) })).json();
  const version = String(release.tag_name ?? "").replace(/^v/, "");
  const asset = ghAssetName(version);
  const url = release.assets?.find((a) => a.name === asset)?.browser_download_url;
  if (!version || !asset || !url) throw new LabError(`no GitHub CLI release asset for ${process.platform}/${process.arch}; install it from https://cli.github.com`);
  log(`downloading the GitHub CLI ${version} (${asset}) into ${common.LOCAL_BIN}`);
  const scratch = mkdtempSync(join(tmpdir(), "gh-install-"));
  try {
    const archive = join(scratch, asset);
    writeFileSync(archive, Buffer.from(await (await fetch(url, { signal: AbortSignal.timeout(300_000) })).arrayBuffer()));
    const extracted = join(scratch, "x");
    mkdirSync(extracted);
    const unpack = asset.endsWith(".zip") ? spawnSync("unzip", ["-q", archive, "-d", extracted], { stdio: "ignore", timeout: 120_000 }) : spawnSync("tar", ["-xzf", archive, "-C", extracted], { stdio: "ignore", timeout: 120_000 });
    if (unpack.error || unpack.status !== 0) throw new LabError("could not unpack the GitHub CLI archive");
    const binary = findFile(extracted, "gh");
    if (!binary) throw new LabError("the GitHub CLI archive had no gh binary");
    mkdirSync(common.LOCAL_BIN, { recursive: true });
    copyFileSync(binary, join(common.LOCAL_BIN, "gh"));
    chmodSync(join(common.LOCAL_BIN, "gh"), 0o755);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return existsSync(join(common.LOCAL_BIN, "gh"));
}

function repoFromGit() {
  const result = spawnSync("git", ["remote", "get-url", "origin"], { encoding: "utf8", cwd: common.REPO_ROOT, timeout: 10_000 });
  return result.status === 0 ? parseRepoFromRemote(result.stdout) : null;
}

async function ghLoggedIn() {
  const binary = common.ghBinary();
  return Boolean(binary) && commandOk(binary, ["auth", "status", "-h", "github.com"]);
}

/** GitHub device-flow sign-in: gh prints a one-time code and URL, which we relay, then waits for the engineer. */
export function ghLogin({ timeoutMs = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const binary = common.ghBinary();
    if (!binary) return reject(new LabError("the GitHub CLI is not installed"));
    const child = spawn(binary, ["auth", "login", "-h", "github.com", "-p", "https", "-w", "--skip-ssh-key"], { stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    let code = "";
    const relay = (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const codeMatch = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(line);
        if (codeMatch) {
          code = codeMatch[1];
          const copied = common.copyToClipboard(code);
          log(`GitHub one-time code ${code}${copied ? " (copied to the clipboard)" : ""}`);
          continue;
        }
        const urlMatch = /(https:\/\/github\.com\/login\/device\S*)/.exec(line);
        if (urlMatch) {
          const opened = common.openInBrowser(urlMatch[1]);
          log(opened ? `opened ${urlMatch[1]} in the browser: paste the code ${code || "shown above"} there and approve` : `open ${urlMatch[1]} and enter the code ${code || "shown above"}`);
          continue;
        }
        log(`gh: ${line.replace(/^!\s*/, "")}`);
      }
    };
    child.stdout.on("data", relay);
    child.stderr.on("data", relay);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new LabError(`the GitHub sign-in was not completed within ${Math.round(timeoutMs / 60_000)} minutes`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new LabError(`gh auth login failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (buffer.trim()) log(`gh: ${buffer.trim()}`);
      code === 0 ? resolve() : reject(new LabError(`gh auth login exited with code ${code}`));
    });
  });
}

async function installGh() {
  if (process.platform === "darwin" && commandOk("brew", ["--version"])) {
    log("installing the GitHub CLI with Homebrew");
    const result = spawnSync("brew", ["install", "gh"], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 600_000 });
    if (result.status === 0 && common.ghBinary()) return true;
    log(`brew install gh did not work: ${(result.stderr || "").trim().slice(-200)}; downloading the release instead`);
  }
  if (process.platform === "win32" && commandOk("winget", ["--version"])) {
    log("installing the GitHub CLI with winget");
    const result = spawnSync("winget", ["install", "--id", "GitHub.cli", "-e", "--silent", "--accept-package-agreements", "--accept-source-agreements"], { stdio: "ignore", timeout: 600_000 });
    return result.status === 0 && Boolean(common.ghBinary());
  }
  try {
    return await downloadGh();
  } catch (error) {
    log(error instanceof LabError ? error.message : `download failed: ${error.message}`);
    return false;
  }
}

async function repoAccessible(repo) {
  return (await keyWrap.gh(["api", `repos/${repo}`, "-q", ".full_name"], { allowFailure: true })) !== null;
}

async function acceptInvitation(repo) {
  const text = await keyWrap.gh(["api", "user/repository_invitations"], { allowFailure: true });
  const invitation = text ? findInvitation(JSON.parse(text), repo) : null;
  if (!invitation) return false;
  await keyWrap.gh(["api", "-X", "PATCH", `user/repository_invitations/${invitation.id}`]);
  log(`accepted the invitation to ${repo}`);
  return true;
}

// ------------------------------------------------------------ the checks
export async function doctor(values) {
  const fix = Boolean(values.fix);
  const rows = [];
  let pending = 0;
  const report = (check, ok, detail) => {
    rows.push([check, ok ? "ok" : "needs you", detail]);
    if (!ok) pending += 1;
  };

  report("Node 22+", nodeVersionOk(), nodeVersionOk() ? `node ${process.versions.node}` : `node ${process.versions.node}; install Node 22 or newer (https://nodejs.org or brew install node)`);

  let gh = Boolean(common.ghBinary());
  if (!gh && fix) gh = await installGh();
  report("GitHub CLI", gh, gh ? common.ghBinary() : "install it: https://cli.github.com (brew install gh on macOS)");

  let loggedIn = gh && (await ghLoggedIn());
  if (gh && !loggedIn && fix) {
    log("signing you in to GitHub: a page opens; the one-time code goes on your clipboard");
    await ghLogin();
    loggedIn = await ghLoggedIn();
  }
  report("GitHub sign-in", loggedIn, loggedIn ? "gh is logged in" : "run: gh auth login --web");

  const repo = values.repo ?? repoFromGit() ?? null;
  let access = false;
  if (loggedIn && repo) {
    access = await repoAccessible(repo);
    if (!access && fix && (await acceptInvitation(repo))) access = await repoAccessible(repo);
  }
  report("repository access", access, access ? repo : repo ? `no access to ${repo}: accept the invitation email, or ask the owner to invite you` : "could not determine the repository (git remote origin)");

  let ownerSetup = false;
  if (access) {
    const role = await keyWrap.gh(["variable", "get", keyWrap.KEY_ARN_VARIABLE, "--repo", repo], { allowFailure: true });
    const pub = await keyWrap.gh(["variable", "get", keyWrap.PUBLIC_KEY_VARIABLE, "--repo", repo], { allowFailure: true });
    ownerSetup = Boolean(role && pub);
  }
  report("lab account setup", ownerSetup, ownerSetup ? "repository variables present" : "the owner has not finished docs/09 one-time setup");

  let vapi = vapiCli.vapiBinary();
  if (!vapi && fix) vapi = vapiCli.installVapiCli();
  report("Vapi CLI", Boolean(vapi), vapi ? vapi : "install it: curl -sSL https://vapi.ai/install.sh | bash");

  let accounts = vapi ? vapiCli.listAccounts(vapiCli.readConfig()) : [];
  if (vapi && accounts.length === 0 && fix) {
    log("signing you in to Vapi: a browser page opens, sign in and pick your org");
    await vapiCli.login();
    accounts = vapiCli.listAccounts(vapiCli.readConfig());
  }
  const vapiDetail = accounts.length === 0 ? "no login yet (remote provision opens the Vapi sign-in)" : accounts.length === 1 ? `${accounts[0].name}${accounts[0].organization ? ` (${accounts[0].organization})` : ""}` : `${accounts.length} orgs: ${accounts.map((a) => a.name).join(", ")}; pick one with --vapi-account`;
  report("Vapi sign-in", accounts.length >= 1, vapiDetail);

  common.printTable(rows);
  if (pending) throw new LabError(`${pending} check${pending === 1 ? "" : "s"} still need${pending === 1 ? "s" : ""} attention${fix ? "" : " (re-run with --fix to install and sign in)"}`);
  log("everything is in place for remote mode");
}
