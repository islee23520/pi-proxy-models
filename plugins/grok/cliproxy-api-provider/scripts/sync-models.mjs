#!/usr/bin/env node
/**
 * CLIProxyAPIProvider — sync CLIProxy /v1/models into a managed models file,
 * then compose ~/.grok/config.toml from user settings + that managed file.
 *
 * SSOT for context_window: ~/.agents/references/model-catalog.json
 * (symlinked at ~/.grok/references/model-catalog.json).
 *
 * Managed TOML lives OUTSIDE config.toml:
 *   ~/.agents/references/cliproxy-models.managed.toml
 *   ~/.grok/references/cliproxy-models.managed.toml  -> symlink
 *
 * Grok itself does not support TOML includes, so config.toml is still a
 * composed file: user settings + managed block between markers. Edit user
 * settings only; never hand-edit the managed block or the managed file
 * (re-run this script instead).
 *
 * Usage:
 *   node sync-models.mjs              # normal sync
 *   node sync-models.mjs --force      # ignore cache / always rewrite if changed
 *   node sync-models.mjs --dry-run    # print managed block, do not write
 *   node sync-models.mjs --hook       # quiet mode for SessionStart hooks
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = process.env.GROK_PLUGIN_ROOT || path.resolve(__dirname, "..");
const HOME = os.homedir();
const PLUGIN_DATA =
  process.env.GROK_PLUGIN_DATA ||
  path.join(HOME, ".grok", "plugin-data", "cliproxy-api-provider");

const BEGIN = "# >>> CLIProxyAPIProvider managed begin";
const END = "# >>> CLIProxyAPIProvider managed end";
const GENERATOR = "CLIProxyAPIProvider plugin — do not edit inside this block";

// Canonical shared reference tree (also used by agents / other CLIs)
const AGENTS_REFERENCES = path.join(HOME, ".agents", "references");
const GROK_REFERENCES = path.join(HOME, ".grok", "references");
const DEFAULT_CATALOG = path.join(AGENTS_REFERENCES, "model-catalog.json");
const DEFAULT_MANAGED_TOML = path.join(
  AGENTS_REFERENCES,
  "cliproxy-models.managed.toml",
);
const DEFAULT_USER_CONFIG = path.join(HOME, ".grok", "config.user.toml");

const DEFAULTS = {
  baseUrl: "http://127.0.0.1:8317/v1",
  defaultModel: "grok-4.5",
  webSearch: "grok-4.20-multi-agent-0309",
  defaultReasoningEffort: "high",
  envKey: "XAI_API_KEY",
  apiBackend: "chat_completions",
  configPath: path.join(HOME, ".grok", "config.toml"),
  userConfigPath: DEFAULT_USER_CONFIG,
  managedTomlPath: DEFAULT_MANAGED_TOML,
  catalogPath: DEFAULT_CATALOG,
  // Only rewrite if catalog fingerprint changed, unless --force
  cachePath: path.join(PLUGIN_DATA, "last-sync.json"),
  timeoutMs: 4000,
};

function parseArgs(argv) {
  const flags = new Set();
  for (const a of argv) {
    if (a.startsWith("--")) flags.add(a.slice(2));
  }
  return {
    force: flags.has("force"),
    dryRun: flags.has("dry-run"),
    hook: flags.has("hook"),
    help: flags.has("help") || flags.has("h"),
  };
}

function log(msg, { hook } = {}) {
  if (hook) return;
  process.stderr.write(`[CLIProxyAPIProvider] ${msg}\n`);
}

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return p;
}

function loadPluginConfig() {
  const candidates = [
    path.join(PLUGIN_DATA, "config.json"),
    path.join(PLUGIN_ROOT, "config.json"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(p, "utf8")), _configPath: p };
      }
    } catch {
      // ignore
    }
  }
  return { ...DEFAULTS };
}

function resolveApiKey(envKeyName) {
  const names = Array.isArray(envKeyName) ? envKeyName : [envKeyName];
  for (const n of names) {
    const v = process.env[n];
    if (v && String(v).trim()) return String(v).trim();
  }
  // Common fallbacks for local CLIProxy setups
  for (const n of ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY", "OPENAI_API_KEY", "CLIPROXY_API_KEY"]) {
    const v = process.env[n];
    if (v && String(v).trim()) return String(v).trim();
  }
  return "cliproxy";
}

/**
 * Load vendor-docs catalog. Returns Map mid -> { contextWindow, reasoning? }.
 * Missing / unreadable catalog is non-fatal (falls back to heuristics).
 */
function loadCatalog(catalogPath) {
  const p = expandHome(catalogPath);
  try {
    if (!fs.existsSync(p)) return { path: p, byId: new Map(), ok: false };
    const json = JSON.parse(fs.readFileSync(p, "utf8"));
    const byId = new Map();
    for (const [id, meta] of Object.entries(json.models || {})) {
      byId.set(id, meta);
    }
    return { path: p, byId, ok: true, updated: json.updated };
  } catch (err) {
    return { path: p, byId: new Map(), ok: false, error: err.message };
  }
}

/** Heuristic fallback only when catalog has no entry for this id. */
function heuristicContextWindow(mid) {
  if (mid.startsWith("gpt-5.3-codex")) return 256000;
  if (mid.startsWith("gpt-5.") || mid.startsWith("gpt-oss")) return 400000;
  if (mid.startsWith("gpt-image")) return 128000;
  if (mid.includes("gemini")) return 1048576;
  if (mid.startsWith("codex-")) return 256000;
  // Prefer conservative 200k when unknown — do NOT invent 2M for grok.
  return 200000;
}

function contextWindow(mid, catalog) {
  const meta = catalog.byId.get(mid);
  if (meta && typeof meta.contextWindow === "number" && meta.contextWindow > 0) {
    return { value: meta.contextWindow, source: "catalog" };
  }
  // Also try bare slug for provider-prefixed ids (z-ai/glm-...)
  if (mid.includes("/")) {
    const slug = mid.split("/").pop();
    const m2 = catalog.byId.get(slug);
    if (m2 && typeof m2.contextWindow === "number" && m2.contextWindow > 0) {
      return { value: m2.contextWindow, source: "catalog-slug" };
    }
  }
  return { value: heuristicContextWindow(mid), source: "heuristic" };
}

/**
 * @returns {null | { default: string, efforts: string[] }}
 */
function effortSupport(mid, catalog) {
  if (/(imagine|image|video)/i.test(mid)) return null;
  if (mid.endsWith("non-reasoning")) return null;
  if (mid === "grok-build-0.1" || mid === "grok-composer-2.5-fast") return null;
  if (mid.startsWith("codex-auto")) return null;

  // Normalize provider-prefixed ids (e.g. z-ai/glm-5.2-ultrafast)
  const slug = mid.includes("/") ? mid.split("/").pop() : mid;

  // Catalog reasoning flag is advisory for "does the model do reasoning";
  // proxy acceptance still wins for edge cases (handled by hard excludes above).
  const cat = catalog.byId.get(mid) || catalog.byId.get(slug);
  const catSaysNo = cat && cat.reasoning === false;

  const isGpt = slug.startsWith("gpt-5.") || slug.startsWith("gpt-oss");
  const isGrok = slug.startsWith("grok-");
  const isClaude = slug.startsWith("claude-");
  const isGemini = slug.startsWith("gemini-");
  const isGlm = slug.startsWith("glm-");
  const isKimi = slug.startsWith("kimi-") || slug.startsWith("moonshot-");
  const isThinking = /thinking|reason/i.test(slug);

  if (!(isGpt || isGrok || isClaude || isGemini || isGlm || isKimi || isThinking)) {
    // If catalog says reasoning:true for an unknown family, still enable.
    if (cat && cat.reasoning === true) {
      return { default: "high", efforts: ["low", "medium", "high", "xhigh"] };
    }
    return null;
  }
  if (catSaysNo && !isThinking) return null;

  let def = "high";
  if (
    slug.endsWith("-mini") ||
    slug.endsWith("-flash") ||
    slug.endsWith("-lite") ||
    slug.endsWith("-low") ||
    slug.endsWith("-air") ||
    slug.endsWith("-turbo") ||
    slug.includes("flash") ||
    slug.includes("ultrafast") ||
    slug.includes("composer")
  ) {
    def = "medium";
  }
  if (slug === "kimi-k3") {
    def = "max";
  } else if (
    slug === "grok-4.5" ||
    slug === "grok-4.3" ||
    slug === "grok-4.20-0309-reasoning" ||
    slug === "grok-4.20-multi-agent-0309" ||
    isKimi ||
    isThinking
  ) {
    def = "high";
  }
  const efforts = isKimi
    ? ["low", "high", "max"]
    : isGpt
      ? ["none", "minimal", "low", "medium", "high", "xhigh"]
      : ["low", "medium", "high", "xhigh"];
  return { default: def, efforts };
}

function modelKey(mid) {
  // Quote keys with dots/slashes/hyphens for TOML safety
  if (/[^A-Za-z0-9_]/.test(mid)) return `model."${mid}"`;
  return `model.${mid}`;
}

function tomlStringArray(arr) {
  return `[${arr.map((s) => `"${s}"`).join(", ")}]`;
}

async function fetchModels(baseUrl, apiKey, timeoutMs) {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GET ${url} -> ${res.status} ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const ids = (json.data || [])
      .map((m) => m.id)
      .filter(Boolean)
      .sort();
    if (!ids.length) throw new Error(`empty model list from ${url}`);
    return ids;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Build the managed TOML body (no BEGIN/END markers — those wrap it in config.toml).
 * This is the durable external file content.
 */
function buildManagedToml({
  baseUrl,
  envKey,
  apiBackend,
  defaultModel,
  webSearch,
  defaultReasoningEffort,
  ids,
  catalog,
}) {
  const lines = [];
  lines.push(`# Generated by ${GENERATOR}`);
  lines.push(`# DO NOT EDIT — re-run: node ~/.grok/plugins/cliproxy-api-provider/scripts/sync-models.mjs --force`);
  lines.push(`# source_proxy = ${baseUrl}`);
  lines.push(`# source_catalog = ${catalog.path}`);
  lines.push(`# catalog_ok = ${catalog.ok}`);
  if (catalog.updated) lines.push(`# catalog_updated = ${catalog.updated}`);
  lines.push(`# generated_at = ${new Date().toISOString()}`);
  lines.push(`# model_count = ${ids.length}`);
  lines.push("#");
  lines.push("# context_window SSOT: ~/.agents/references/model-catalog.json");
  lines.push("# (linked from ~/.grok/references/model-catalog.json).");
  lines.push("# Grok cannot include TOML files, so this file is also injected into");
  lines.push("# ~/.grok/config.toml between CLIProxyAPIProvider managed markers.");
  lines.push("");
  lines.push("[endpoints]");
  lines.push(`models_base_url = "${baseUrl}"`);
  lines.push("");
  lines.push("[models]");
  lines.push(`default = "${defaultModel}"`);
  if (webSearch) lines.push(`web_search = "${webSearch}"`);
  lines.push(`default_reasoning_effort = "${defaultReasoningEffort}"`);
  lines.push("");
  lines.push("# Pin sisyphus when present (safe even if disabled).");
  lines.push("[subagents.models]");
  lines.push(`sisyphus = "${defaultModel}"`);
  lines.push(`default = "${defaultModel}"`);
  lines.push("");

  // Useful alias used by many workflows
  const gbCw = contextWindow("grok-build-0.1", catalog);
  lines.push("[model.grok-build]");
  lines.push('model = "grok-build-0.1"');
  lines.push(`base_url = "${baseUrl}"`);
  lines.push('name = "CLIProxy grok-build (alias)"');
  lines.push(`env_key = "${envKey}"`);
  lines.push(`api_backend = "${apiBackend}"`);
  lines.push(`context_window = ${gbCw.value}`);
  lines.push("supports_reasoning_effort = false");
  lines.push("");

  let catalogHits = 0;
  let heuristicHits = 0;
  for (const mid of ids) {
    const cw = contextWindow(mid, catalog);
    if (cw.source.startsWith("catalog")) catalogHits += 1;
    else heuristicHits += 1;

    lines.push(`[${modelKey(mid)}]`);
    lines.push(`model = "${mid}"`);
    lines.push(`base_url = "${baseUrl}"`);
    lines.push(`name = "CLIProxy ${mid}"`);
    lines.push(`env_key = "${envKey}"`);
    lines.push(`api_backend = "${apiBackend}"`);
    lines.push(`context_window = ${cw.value}`);
    if (mid === "grok-4.20-multi-agent-0309") {
      lines.push("supports_backend_search = true");
    }
    const eff = effortSupport(mid, catalog);
    if (eff) {
      lines.push("supports_reasoning_effort = true");
      lines.push(`reasoning_effort = "${eff.default}"`);
      lines.push(`reasoning_efforts = ${tomlStringArray(eff.efforts)}`);
    } else {
      lines.push("supports_reasoning_effort = false");
    }
    lines.push("");
  }

  // trailing stats comment
  lines.push(`# stats: catalog_context_window=${catalogHits} heuristic_fallback=${heuristicHits}`);
  lines.push("");
  return {
    text: lines.join("\n"),
    catalogHits,
    heuristicHits,
  };
}

function wrapManagedBlock(managedTomlBody) {
  return `${BEGIN}\n${managedTomlBody.trimEnd()}\n${END}\n`;
}

/**
 * Remove prior managed blocks (ours + legacy ocx-models markers).
 */
function stripManaged(text) {
  let out = text;
  const patterns = [
    /# >>> CLIProxyAPIProvider managed begin[\s\S]*?# >>> CLIProxyAPIProvider managed end\n?/g,
    // orphan end marker (broken prior state)
    /^# >>> CLIProxyAPIProvider managed end\n?/gm,
    /# >>> ocx-models-plugin managed begin[\s\S]*?# >>> ocx-models-plugin managed end\n?/g,
    /# >>> ocx-models-plugin route begin[\s\S]*?# >>> ocx-models-plugin route end\n?/g,
  ];
  for (const re of patterns) out = out.replace(re, "");
  return out;
}

/**
 * Strip provider-owned sections that may sit outside markers (legacy / broken state).
 */
function stripProviderOwnedSections(text) {
  const sectionRe = /^\[([^\]]+)\][^\n]*\n(?:(?!^\[)[^\n]*\n?)*/gm;
  let out = "";
  let last = 0;
  let m;
  const src = text;
  while ((m = sectionRe.exec(src))) {
    const full = m[0];
    const name = m[1];
    const start = m.index;
    out += src.slice(last, start);
    last = start + full.length;

    const drop =
      (name === "endpoints" && /models_base_url\s*=/.test(full)) ||
      (name === "models" &&
        /default\s*=/.test(full) &&
        !/\[model\./.test(full) &&
        (full.includes("default_reasoning_effort") ||
          full.includes("web_search") ||
          /default\s*=\s*"grok-/.test(full))) ||
      (name === "subagents.models" &&
        /sisyphus\s*=/.test(full) &&
        full.split("\n").filter((l) => l.includes("=")).length <= 4) ||
      name === "model.grok-build" ||
      name.startsWith("model.") ||
      name.startsWith('model."');

    if (!drop) out += full;
  }
  out += src.slice(last);
  return out;
}

function ensurePluginsEnabled(text, pluginName) {
  if (!/\[plugins\]/.test(text)) {
    return text.replace(
      /(\[cli\][\s\S]*?(?=\n\[|\n*$))/,
      (block) =>
        `${block.trimEnd()}\n\n[plugins]\nenabled = ["lfg", "${pluginName}"]\n`,
    );
  }

  const pluginsSectionRe = /(\[plugins\][^\n]*\n)([\s\S]*?)(?=\n\[|\n*$)/;
  const m = text.match(pluginsSectionRe);
  if (!m) return text;

  const body = m[2];
  const enabledRe = /enabled\s*=\s*\[([\s\S]*?)\]/;
  const em = body.match(enabledRe);
  if (!em) {
    const insert = `enabled = ["${pluginName}"]\n`;
    return text.replace(pluginsSectionRe, `${m[1]}${insert}${body}`);
  }

  const list = em[1];
  if (list.includes(`"${pluginName}"`) || list.includes(`'${pluginName}'`)) {
    return text;
  }

  let nextList;
  if (list.includes("\n")) {
    const trimmed = list.replace(/\s*$/, "");
    const needsComma =
      /"[^"]+"\s*$/.test(trimmed.trim()) || /'[^']+'\s*$/.test(trimmed.trim());
    nextList = `${trimmed}${needsComma ? "," : ""}\n    "${pluginName}",\n`;
  } else {
    const items = list
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    items.push(`"${pluginName}"`);
    nextList = items.join(", ");
  }

  const newBody = body.replace(enabledRe, `enabled = [${nextList}]`);
  return text.replace(pluginsSectionRe, `${m[1]}${newBody}`);
}

/**
 * Extract pure user settings from an existing config.toml into config.user.toml
 * when the user file does not exist yet.
 */
function extractUserConfig(configText) {
  let next = stripManaged(configText);
  next = stripProviderOwnedSections(next);
  next = next.replace(/\n{3,}/g, "\n\n").trim() + "\n";
  return next;
}

function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

function writeConfigWithBackup(configPath, nextText) {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  const bak = `${configPath}.cliproxy-backup-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}`;
  if (fs.existsSync(configPath)) {
    fs.copyFileSync(configPath, bak);
  }
  writeFileAtomic(configPath, nextText);
  return bak;
}

function ensureSymlink(linkPath, targetPath) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    if (fs.existsSync(linkPath) || fs.lstatSync(linkPath).isSymbolicLink()) {
      const st = fs.lstatSync(linkPath);
      if (st.isSymbolicLink()) {
        const cur = fs.readlinkSync(linkPath);
        if (path.resolve(path.dirname(linkPath), cur) === path.resolve(targetPath)) {
          return; // already correct
        }
        fs.unlinkSync(linkPath);
      } else {
        // real file — leave alone if identical content, else replace with symlink after backup
        const bak = `${linkPath}.bak-${Date.now()}`;
        fs.renameSync(linkPath, bak);
      }
    }
  } catch (e) {
    if (e.code !== "ENOENT") {
      // try unlink broken link
      try {
        fs.unlinkSync(linkPath);
      } catch {
        /* ignore */
      }
    }
  }
  fs.symlinkSync(targetPath, linkPath);
}

function fingerprint(ids, baseUrl, catalog) {
  // Include catalog mtime/updated so catalog edits force resync
  const catKey = catalog.ok
    ? `${catalog.updated || ""}:${catalog.byId.size}`
    : "no-catalog";
  return `${baseUrl}|${catKey}|${ids.join(",")}`;
}

function readCache(cachePath) {
  try {
    return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } catch {
    return null;
  }
}

function writeCache(cachePath, data) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write(
      `Usage: sync-models.mjs [--force] [--dry-run] [--hook]\n\n` +
        `Writes managed models to ~/.agents/references/cliproxy-models.managed.toml\n` +
        `and composes ~/.grok/config.toml = config.user.toml + managed block.\n` +
        `context_window SSOT: ~/.agents/references/model-catalog.json\n`,
    );
    process.exit(0);
  }

  const cfg = loadPluginConfig();
  const baseUrl = process.env.CLIPROXY_BASE_URL || cfg.baseUrl;
  const configPath = expandHome(process.env.GROK_CONFIG || cfg.configPath);
  const userConfigPath = expandHome(
    process.env.GROK_USER_CONFIG || cfg.userConfigPath || DEFAULT_USER_CONFIG,
  );
  const managedTomlPath = expandHome(
    process.env.CLIPROXY_MANAGED_TOML || cfg.managedTomlPath || DEFAULT_MANAGED_TOML,
  );
  const catalogPath = expandHome(
    process.env.MODEL_CATALOG || cfg.catalogPath || DEFAULT_CATALOG,
  );
  const envKey = cfg.envKey || "XAI_API_KEY";
  const apiKey = resolveApiKey(envKey);

  const catalog = loadCatalog(catalogPath);
  if (!catalog.ok) {
    log(
      `warning: model-catalog not loaded (${catalog.error || "missing"} @ ${catalog.path}); using heuristics`,
      flags,
    );
  } else {
    log(`catalog: ${catalog.byId.size} models from ${catalog.path}`, flags);
  }

  let ids;
  try {
    ids = await fetchModels(baseUrl, apiKey, cfg.timeoutMs || 4000);
  } catch (err) {
    log(`skip sync: CLIProxy unreachable (${err.message})`, flags);
    // Do not fail SessionStart hard — exit 0 so Grok keeps going
    process.exit(0);
  }

  const fp = fingerprint(ids, baseUrl, catalog);
  const cache = readCache(cfg.cachePath);
  const existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const hasManaged = existing.includes(BEGIN) && existing.includes(END);
  const managedExists = fs.existsSync(managedTomlPath);

  if (!flags.force && cache?.fingerprint === fp && hasManaged && managedExists) {
    log(`up-to-date (${ids.length} models @ ${baseUrl})`, flags);
    process.exit(0);
  }

  const built = buildManagedToml({
    baseUrl,
    envKey,
    apiBackend: cfg.apiBackend || "chat_completions",
    defaultModel: cfg.defaultModel || "grok-4.5",
    webSearch: cfg.webSearch || "grok-4.20-multi-agent-0309",
    defaultReasoningEffort: cfg.defaultReasoningEffort || "high",
    ids,
    catalog,
  });
  const managedBlock = wrapManagedBlock(built.text);

  if (flags.dryRun) {
    process.stdout.write(managedBlock);
    process.exit(0);
  }

  // 1) Ensure user config file exists (extract once from current config if needed)
  if (!fs.existsSync(userConfigPath)) {
    const extracted = extractUserConfig(existing || "");
    writeFileAtomic(userConfigPath, extracted);
    log(`created user config: ${userConfigPath}`, flags);
  }

  // 2) Write external managed TOML (SSOT for composed model block)
  writeFileAtomic(managedTomlPath, built.text.endsWith("\n") ? built.text : built.text + "\n");
  log(`wrote managed models: ${managedTomlPath}`, flags);

  // 3) Symlink into ~/.grok/references/ (and keep model-catalog link if present)
  try {
    ensureSymlink(
      path.join(GROK_REFERENCES, "cliproxy-models.managed.toml"),
      managedTomlPath,
    );
    // Also ensure lina sees it if that tree exists
    const linaRef = path.join(HOME, ".lina", "references", "cliproxy-models.managed.toml");
    if (fs.existsSync(path.dirname(linaRef)) || fs.existsSync(path.join(HOME, ".lina"))) {
      fs.mkdirSync(path.dirname(linaRef), { recursive: true });
      ensureSymlink(linaRef, managedTomlPath);
    }
  } catch (err) {
    log(`warning: symlink setup failed: ${err.message}`, flags);
  }

  // 4) Compose config.toml = user settings + managed block
  let userText = fs.readFileSync(userConfigPath, "utf8");
  // Guard: if someone stuffed managed content into user file, strip it
  userText = stripManaged(userText);
  userText = stripProviderOwnedSections(userText);
  userText = ensurePluginsEnabled(userText, "cliproxy-api-provider");
  // Persist cleaned user file if we had to strip junk
  const cleanedUser = userText.replace(/\n{3,}/g, "\n\n").trim() + "\n";
  if (cleanedUser !== fs.readFileSync(userConfigPath, "utf8")) {
    writeFileAtomic(userConfigPath, cleanedUser);
  }

  const next =
    cleanedUser.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n\n" + managedBlock;

  if (!flags.force && next.trim() === existing.trim() && managedExists) {
    log("no config changes", flags);
    writeCache(cfg.cachePath, {
      fingerprint: fp,
      synced_at: new Date().toISOString(),
      model_count: ids.length,
      base_url: baseUrl,
      catalog_hits: built.catalogHits,
      heuristic_hits: built.heuristicHits,
      managed_toml: managedTomlPath,
      user_config: userConfigPath,
    });
    process.exit(0);
  }

  const bak = writeConfigWithBackup(configPath, next);
  writeCache(cfg.cachePath, {
    fingerprint: fp,
    synced_at: new Date().toISOString(),
    model_count: ids.length,
    base_url: baseUrl,
    backup: bak,
    catalog_hits: built.catalogHits,
    heuristic_hits: built.heuristicHits,
    managed_toml: managedTomlPath,
    user_config: userConfigPath,
    catalog_path: catalog.path,
    catalog_ok: catalog.ok,
  });

  log(
    `synced ${ids.length} models -> ${configPath} (catalog cw=${built.catalogHits}, heuristic=${built.heuristicHits})`,
    flags,
  );
  if (!flags.hook) {
    log(`managed file: ${managedTomlPath}`, flags);
    log(`user config:  ${userConfigPath}`, flags);
    log(`backup: ${bak}`, flags);
  }
  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`[CLIProxyAPIProvider] fatal: ${err?.stack || err}\n`);
  // SessionStart hooks should not hard-fail the session
  process.exit(0);
});
