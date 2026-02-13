#!/usr/bin/env node
"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { execSync } = require("node:child_process");
const crypto = require("node:crypto");
const { URL } = require("node:url");

const EPOCH_OFFSET_MICROSECONDS = 11644473600000000n;
const CHECKSUM_TYPE_URL = "url";
const CHECKSUM_TYPE_FOLDER = "folder";

function nowChromeTimestamp() {
  return (BigInt(Date.now()) * 1000n + EPOCH_OFFSET_MICROSECONDS).toString();
}

function parseArgs(argv) {
  const args = {
    configPath: "bookmark-sorter.config.json",
    profile: null,
    dryRun: true,
    apply: false,
    exportHtmlPath: null,
    allowAccountApply: false,
    backupsDir: "backups",
    destinationRoot: null,
    bookmarksPath: null,
    force: false
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") {
      args.configPath = argv[++i];
    } else if (arg === "--profile") {
      args.profile = argv[++i];
    } else if (arg === "--bookmarks-file") {
      args.bookmarksPath = argv[++i];
    } else if (arg === "--backup-dir") {
      args.backupsDir = argv[++i];
    } else if (arg === "--export-html") {
      args.exportHtmlPath = argv[++i];
    } else if (arg === "--destination-root") {
      args.destinationRoot = argv[++i];
    } else if (arg === "--apply") {
      args.apply = true;
      args.dryRun = false;
    } else if (arg === "--allow-account-apply") {
      args.allowAccountApply = true;
    } else if (arg === "--force") {
      args.force = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
      args.apply = false;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`
Chrome Bookmark Sorter

Usage:
  node bookmark-sorter.js [options]

Options:
  --config <path>             Config JSON path (default: bookmark-sorter.config.json)
  --profile <name>            Chrome profile folder name (default: Chrome last-used profile)
  --bookmarks-file <path>     Explicit path to Chrome AccountBookmarks/Bookmarks file
  --backup-dir <path>         Backup folder path (default: backups)
  --export-html <path>        Write sorted bookmarks as importable HTML (sync-safe mode)
  --destination-root <root>   Override destination root (bookmark_bar | other | synced)
  --dry-run                   Show planned changes only (default)
  --apply                     Write changes to bookmarks file + create backup
  --allow-account-apply       Allow direct write to AccountBookmarks (advanced/risky)
  --force                     Allow --apply even if Chrome is running
  --help, -h                  Show this help

Examples:
  node bookmark-sorter.js --dry-run
  node bookmark-sorter.js --export-html .\\sorted-bookmarks.html
  node bookmark-sorter.js --apply
  node bookmark-sorter.js --apply --force
  node bookmark-sorter.js --apply --allow-account-apply
  node bookmark-sorter.js --profile "Profile 2" --apply
  node bookmark-sorter.js --bookmarks-file "C:\\Users\\you\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Bookmarks" --apply
  node bookmark-sorter.js --bookmarks-file "C:\\Users\\you\\AppData\\Local\\Google\\Chrome\\User Data\\Profile 3\\AccountBookmarks" --apply
`.trim());
}

function getChromeUserDataDir() {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    throw new Error("LOCALAPPDATA is not set. Use --bookmarks-file to pass an explicit path.");
  }

  return path.join(
    localAppData,
    "Google",
    "Chrome",
    "User Data"
  );
}

function getDefaultBookmarksPath(profile) {
  return path.join(
    getChromeUserDataDir(),
    profile
  );
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function detectDefaultBookmarksPath(profile) {
  const profileDir = getDefaultBookmarksPath(profile);
  const candidates = ["AccountBookmarks", "Bookmarks"];

  for (const filename of candidates) {
    const candidatePath = path.join(profileDir, filename);
    if (await pathExists(candidatePath)) {
      return candidatePath;
    }
  }

  throw new Error(
    `No Chrome bookmarks file found in '${profileDir}'. Looked for: ${candidates.join(", ")}`
  );
}

async function detectLastUsedProfileName() {
  const localStatePath = path.join(getChromeUserDataDir(), "Local State");
  if (!(await pathExists(localStatePath))) {
    return "Default";
  }

  try {
    const rawState = await fs.readFile(localStatePath, "utf8");
    const state = parseJsonWithOptionalBom(rawState);
    const lastUsed = String(state?.profile?.last_used || "").trim();
    return lastUsed || "Default";
  } catch {
    return "Default";
  }
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalize(value) {
  return String(value || "").toLowerCase();
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function hostMatchesDomain(host, domain) {
  const normalizedDomain = normalize(domain).replace(/^\./, "");
  if (!normalizedDomain || !host) {
    return false;
  }
  return host === normalizedDomain || host.endsWith(`.${normalizedDomain}`);
}

function toRegex(pattern) {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

function matchSpec(spec, bookmark) {
  if (!spec || typeof spec !== "object") {
    return false;
  }

  const bookmarkNode = bookmark?.bookmark || bookmark;
  const sourcePath = safeArray(bookmark?.sourcePath).map((segment) => String(segment));
  const rootName = normalize(bookmark?.rootName);

  const name = normalize(bookmarkNode?.name);
  const url = normalize(bookmarkNode?.url);
  const both = `${name} ${url}`.trim();
  const host = hostFromUrl(bookmarkNode?.url);
  const pathText = normalize(sourcePath.join(" > "));

  const checks = [];

  const keywords = safeArray(spec.keywords).map(normalize).filter(Boolean);
  if (keywords.length) {
    checks.push(keywords.some((token) => both.includes(token)));
  }

  const nameContains = safeArray(spec.nameContains).map(normalize).filter(Boolean);
  if (nameContains.length) {
    checks.push(nameContains.some((token) => name.includes(token)));
  }

  const urlContains = safeArray(spec.urlContains).map(normalize).filter(Boolean);
  if (urlContains.length) {
    checks.push(urlContains.some((token) => url.includes(token)));
  }

  const domains = safeArray(spec.domains).map(normalize).filter(Boolean);
  if (domains.length) {
    checks.push(domains.some((domain) => hostMatchesDomain(host, domain)));
  }

  const regexPatterns = safeArray(spec.regex).map(toRegex).filter(Boolean);
  if (regexPatterns.length) {
    checks.push(regexPatterns.some((re) => re.test(both)));
  }

  const pathContains = safeArray(spec.pathContains).map(normalize).filter(Boolean);
  if (pathContains.length) {
    checks.push(pathContains.some((token) => pathText.includes(token)));
  }

  const pathRegex = safeArray(spec.pathRegex).map(toRegex).filter(Boolean);
  if (pathRegex.length) {
    checks.push(pathRegex.some((re) => re.test(pathText)));
  }

  const roots = safeArray(spec.roots).map(normalize).filter(Boolean);
  if (roots.length) {
    checks.push(roots.includes(rootName));
  }

  const excludeKeywords = safeArray(spec.excludeKeywords).map(normalize).filter(Boolean);
  if (excludeKeywords.some((token) => both.includes(token))) {
    return false;
  }

  const excludeNameContains = safeArray(spec.excludeNameContains).map(normalize).filter(Boolean);
  if (excludeNameContains.some((token) => name.includes(token))) {
    return false;
  }

  const excludeUrlContains = safeArray(spec.excludeUrlContains).map(normalize).filter(Boolean);
  if (excludeUrlContains.some((token) => url.includes(token))) {
    return false;
  }

  const excludeDomains = safeArray(spec.excludeDomains).map(normalize).filter(Boolean);
  if (excludeDomains.some((domain) => hostMatchesDomain(host, domain))) {
    return false;
  }

  const excludePathContains = safeArray(spec.excludePathContains).map(normalize).filter(Boolean);
  if (excludePathContains.some((token) => pathText.includes(token))) {
    return false;
  }

  const excludePathRegex = safeArray(spec.excludePathRegex).map(toRegex).filter(Boolean);
  if (excludePathRegex.some((re) => re.test(pathText))) {
    return false;
  }

  const excludeRegexPatterns = safeArray(spec.excludeRegex).map(toRegex).filter(Boolean);
  if (excludeRegexPatterns.some((re) => re.test(both))) {
    return false;
  }

  if (!checks.length) {
    return false;
  }

  const mode = spec.mode === "all" ? "all" : "any";
  return mode === "all" ? checks.every(Boolean) : checks.some(Boolean);
}

function classifyWithNode(node, bookmark, pathPrefix) {
  const currentPath = [...pathPrefix, node.name];
  const children = safeArray(node.children);

  for (const child of children) {
    const result = classifyWithNode(child, bookmark, currentPath);
    if (result) {
      return result;
    }
  }

  if (matchSpec(node.match, bookmark)) {
    return currentPath;
  }

  return null;
}

function classifyBookmark(bookmark, categories, defaultPath) {
  for (const category of safeArray(categories)) {
    const result = classifyWithNode(category, bookmark, []);
    if (result) {
      return result;
    }
  }
  return safeArray(defaultPath).length ? defaultPath : ["Uncategorized"];
}

function collectBookmarksFromNode(node, output, rootName, sourcePath) {
  if (!node || typeof node !== "object") {
    return;
  }

  const children = safeArray(node.children);
  for (const child of children) {
    if (child && child.type === "url") {
      output.push({
        bookmark: child,
        rootName,
        sourcePath
      });
      continue;
    }
    if (child && child.type === "folder") {
      collectBookmarksFromNode(child, output, rootName, [...sourcePath, child.name]);
    }
  }
}

function collectAllBookmarks(data, sourceRoots) {
  const bookmarks = [];
  for (const rootName of sourceRoots) {
    const rootNode = data?.roots?.[rootName];
    if (!rootNode) {
      continue;
    }
    collectBookmarksFromNode(rootNode, bookmarks, rootName, []);
  }
  return bookmarks;
}

function scanMaxIdInNode(node, currentMax) {
  if (!node || typeof node !== "object") {
    return currentMax;
  }

  const idValue = Number.parseInt(String(node.id || ""), 10);
  let max = Number.isFinite(idValue) ? Math.max(currentMax, idValue) : currentMax;

  for (const child of safeArray(node.children)) {
    max = scanMaxIdInNode(child, max);
  }

  return max;
}

function createIdGenerator(data) {
  let max = 0;
  const roots = data?.roots || {};
  for (const rootName of Object.keys(roots)) {
    max = scanMaxIdInNode(roots[rootName], max);
  }

  return () => {
    max += 1;
    return String(max);
  };
}

function createTreeNode() {
  return {
    folders: new Map(),
    bookmarks: []
  };
}

function ensurePath(tree, folderPath) {
  let cursor = tree;
  for (const segment of folderPath) {
    if (!cursor.folders.has(segment)) {
      cursor.folders.set(segment, createTreeNode());
    }
    cursor = cursor.folders.get(segment);
  }
  return cursor;
}

function addConfiguredFolders(tree, categories, prefix) {
  for (const category of safeArray(categories)) {
    const current = [...prefix, category.name];
    ensurePath(tree, current);
    addConfiguredFolders(tree, category.children, current);
  }
}

function sortBookmarksInTree(tree) {
  tree.bookmarks.sort((a, b) => {
    const an = normalize(a.name);
    const bn = normalize(b.name);
    if (an < bn) return -1;
    if (an > bn) return 1;
    return 0;
  });

  for (const child of tree.folders.values()) {
    sortBookmarksInTree(child);
  }
}

function createChromeFolder(name, children, nextId) {
  const now = nowChromeTimestamp();
  return {
    type: "folder",
    name,
    id: nextId(),
    guid: crypto.randomUUID(),
    date_added: now,
    date_last_used: "0",
    date_modified: now,
    children
  };
}

function treeToChromeChildrenOrdered(tree, nextId) {
  const output = [];

  for (const [folderName, folderTree] of tree.folders.entries()) {
    const folderChildren = treeToChromeChildrenOrdered(folderTree, nextId);
    output.push(createChromeFolder(folderName, folderChildren, nextId));
  }

  for (const bookmark of tree.bookmarks) {
    output.push(bookmark);
  }

  return output;
}

function setRootChildren(rootNode, children) {
  rootNode.children = children;
  rootNode.date_modified = nowChromeTimestamp();
}

function pathToKey(folderPath) {
  return folderPath.join(" > ");
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

function getTimestampForFilename() {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

function validateRootNames(sourceRoots, destinationRoot) {
  const valid = new Set(["bookmark_bar", "other", "synced"]);

  for (const root of sourceRoots) {
    if (!valid.has(root)) {
      throw new Error(`Invalid source root '${root}'. Expected one of: bookmark_bar, other, synced`);
    }
  }

  if (!valid.has(destinationRoot)) {
    throw new Error(`Invalid destination root '${destinationRoot}'. Expected one of: bookmark_bar, other, synced`);
  }
}

function summarizeStats(statsMap, total) {
  const entries = [...statsMap.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`Classified ${total} bookmarks.`);
  for (const [pathKey, count] of entries) {
    console.log(`  ${count.toString().padStart(4, " ")}  ${pathKey}`);
  }
}

function sanitizeBookmark(bookmark) {
  const clone = { ...bookmark };
  if (!clone.type) clone.type = "url";
  if (!clone.guid && clone.type === "url") {
    clone.guid = crypto.randomUUID();
  }
  if (!clone.date_last_used) {
    clone.date_last_used = "0";
  }
  return clone;
}

function parseJsonWithOptionalBom(rawText) {
  const cleaned = String(rawText).replace(/^\uFEFF/, "");
  return JSON.parse(cleaned);
}

function isChromeRunning() {
  try {
    if (process.platform === "win32") {
      const output = execSync("tasklist /FI \"IMAGENAME eq chrome.exe\" /NH", {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      });
      return output.toLowerCase().includes("chrome.exe");
    }

    const output = execSync("ps -A -o comm", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return output.toLowerCase().includes("chrome");
  } catch {
    return false;
  }
}

function updateChecksumUtf8(hash, value) {
  if (value === undefined || value === null) {
    return;
  }
  hash.update(Buffer.from(String(value), "utf8"));
}

function updateChecksumUtf16(hash, value) {
  if (value === undefined || value === null) {
    return;
  }
  hash.update(Buffer.from(String(value), "utf16le"));
}

function updateChecksumWithNode(hash, node) {
  if (!node || typeof node !== "object") {
    return;
  }

  const nodeType = node.type === "folder" ? CHECKSUM_TYPE_FOLDER : CHECKSUM_TYPE_URL;
  const nodeId = String(node.id || "");
  const nodeName = String(node.name || "");

  updateChecksumUtf8(hash, nodeId);
  updateChecksumUtf16(hash, nodeName);
  updateChecksumUtf8(hash, nodeType);

  if (nodeType === CHECKSUM_TYPE_URL) {
    updateChecksumUtf8(hash, String(node.url || ""));
    return;
  }

  for (const child of safeArray(node.children)) {
    updateChecksumWithNode(hash, child);
  }
}

function computeBookmarksChecksum(data) {
  const hash = crypto.createHash("md5");
  for (const rootName of ["bookmark_bar", "other", "synced"]) {
    const node = data?.roots?.[rootName];
    if (!node) {
      continue;
    }
    updateChecksumWithNode(hash, node);
  }
  return hash.digest("hex").toLowerCase();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function chromeMicrosToUnixSeconds(value) {
  const raw = String(value || "0").trim();
  if (!raw || raw === "0") {
    return null;
  }

  try {
    const micros = BigInt(raw);
    const unixMicros = micros - EPOCH_OFFSET_MICROSECONDS;
    if (unixMicros <= 0n) {
      return null;
    }
    return Number(unixMicros / 1000000n);
  } catch {
    return null;
  }
}

function renderBookmarkNodeHtml(node, indentLevel) {
  const indent = "  ".repeat(indentLevel);
  if (node.type === "url") {
    const addDate = chromeMicrosToUnixSeconds(node.date_added);
    const addDateAttr = addDate ? ` ADD_DATE="${addDate}"` : "";
    return `${indent}<DT><A HREF="${escapeHtml(node.url)}"${addDateAttr}>${escapeHtml(node.name)}</A>\n`;
  }

  const addDate = chromeMicrosToUnixSeconds(node.date_added);
  const modDate = chromeMicrosToUnixSeconds(node.date_modified);
  const addDateAttr = addDate ? ` ADD_DATE="${addDate}"` : "";
  const modDateAttr = modDate ? ` LAST_MODIFIED="${modDate}"` : "";
  let output = `${indent}<DT><H3${addDateAttr}${modDateAttr}>${escapeHtml(node.name)}</H3>\n`;
  output += `${indent}<DL><p>\n`;
  for (const child of safeArray(node.children)) {
    output += renderBookmarkNodeHtml(child, indentLevel + 1);
  }
  output += `${indent}</DL><p>\n`;
  return output;
}

function buildBookmarksHtml(nodes) {
  let html = "";
  html += "<!DOCTYPE NETSCAPE-Bookmark-file-1>\n";
  html += "<META HTTP-EQUIV=\"Content-Type\" CONTENT=\"text/html; charset=UTF-8\">\n";
  html += "<TITLE>Bookmarks</TITLE>\n";
  html += "<H1>Bookmarks</H1>\n";
  html += "<DL><p>\n";
  for (const node of nodes) {
    html += renderBookmarkNodeHtml(node, 1);
  }
  html += "</DL><p>\n";
  return html;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  if (args.apply && !args.force && isChromeRunning()) {
    throw new Error(
      "Chrome appears to be running. Close all chrome.exe processes and retry --apply, or use --force."
    );
  }

  const configPath = path.resolve(args.configPath);
  const rawConfig = await fs.readFile(configPath, "utf8");
  const config = parseJsonWithOptionalBom(rawConfig);

  const sourceRoots = safeArray(config.sourceRoots).length
    ? safeArray(config.sourceRoots)
    : ["bookmark_bar", "other", "synced"];
  const destinationRoot = args.destinationRoot || config.destinationRoot || "bookmark_bar";
  const organizedFolderName = (config.organizedFolderName || "Organized").trim();
  const includeEmptyFolders = config.includeEmptyFolders !== false;
  const defaultPath = safeArray(config.defaultPath).length ? safeArray(config.defaultPath) : ["Uncategorized"];
  const categories = safeArray(config.categories);

  validateRootNames(sourceRoots, destinationRoot);

  const profileName = args.profile || await detectLastUsedProfileName();
  const bookmarksPath = args.bookmarksPath
    ? path.resolve(args.bookmarksPath)
    : await detectDefaultBookmarksPath(profileName);
  const bookmarksFilename = path.basename(bookmarksPath);

  if (
    args.apply &&
    bookmarksFilename.toLowerCase() === "accountbookmarks" &&
    !args.allowAccountApply
  ) {
    throw new Error(
      "Refusing direct write to AccountBookmarks by default. Use --export-html and import in Chrome (sync-safe), or pass --allow-account-apply to override."
    );
  }

  const rawBookmarks = await fs.readFile(bookmarksPath, "utf8");
  const data = parseJsonWithOptionalBom(rawBookmarks);

  const bookmarkEntries = collectAllBookmarks(data, sourceRoots);
  const tree = createTreeNode();

  if (includeEmptyFolders) {
    addConfiguredFolders(tree, categories, []);
  }

  const stats = new Map();
  for (const bookmarkEntry of bookmarkEntries) {
    const folderPath = classifyBookmark(bookmarkEntry, categories, defaultPath);
    ensurePath(tree, folderPath).bookmarks.push(sanitizeBookmark(bookmarkEntry.bookmark));
    const key = pathToKey(folderPath);
    stats.set(key, (stats.get(key) || 0) + 1);
  }

  sortBookmarksInTree(tree);

  const nextId = createIdGenerator(data);
  const categorizedChildren = treeToChromeChildrenOrdered(tree, nextId);
  const destinationChildren = organizedFolderName
    ? [createChromeFolder(organizedFolderName, categorizedChildren, nextId)]
    : categorizedChildren;

  const destinationNode = data?.roots?.[destinationRoot];
  if (!destinationNode) {
    throw new Error(`Destination root '${destinationRoot}' was not found in Bookmarks file.`);
  }

  for (const rootName of sourceRoots) {
    const node = data?.roots?.[rootName];
    if (!node) {
      continue;
    }
    if (rootName === destinationRoot) {
      setRootChildren(node, destinationChildren);
    } else {
      setRootChildren(node, []);
    }
  }

  console.log(`Bookmarks file: ${bookmarksPath}`);
  if (!args.bookmarksPath) {
    console.log(`Profile:        ${profileName}`);
  }
  console.log(`Config file:    ${configPath}`);
  console.log(`Mode:           ${args.apply ? "APPLY (write changes)" : "DRY RUN (no write)"}`);
  console.log(`Source roots:   ${sourceRoots.join(", ")}`);
  console.log(`Destination:    ${destinationRoot}${organizedFolderName ? `/${organizedFolderName}` : ""}`);
  summarizeStats(stats, bookmarkEntries.length);

  if (args.exportHtmlPath) {
    const exportPath = path.resolve(args.exportHtmlPath);
    const html = buildBookmarksHtml(destinationChildren);
    await ensureDir(path.dirname(exportPath));
    await fs.writeFile(exportPath, html, "utf8");
    console.log(`HTML export:    ${exportPath}`);
  }

  if (!args.apply) {
    if (args.exportHtmlPath) {
      console.log("\nExport complete. Import this HTML from Chrome Bookmark Manager.");
    } else {
      console.log("\nDry run complete. Re-run with --apply after closing Chrome.");
    }
    return;
  }

  const backupsDir = path.resolve(args.backupsDir);
  await ensureDir(backupsDir);
  const backupPath = path.join(
    backupsDir,
    `${bookmarksFilename}.${getTimestampForFilename()}.backup.json`
  );
  await fs.writeFile(backupPath, rawBookmarks, "utf8");

  data.checksum = computeBookmarksChecksum(data);
  await fs.writeFile(bookmarksPath, JSON.stringify(data, null, 2), "utf8");

  console.log(`\nBackup written to: ${backupPath}`);
  console.log(`Bookmarks updated: ${bookmarksPath}`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
