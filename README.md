# Chrome Bookmark Sorter (Windows 11)

Small Node.js CLI tool to auto-organize Google Chrome bookmarks into major/minor folder categories.

GitHub repo description:
Rule-based Chrome bookmark organizer for Windows. Automatically classifies Chrome bookmarks into nested categories, supports profile selection, dry-run/apply modes, backups, and sync-safe HTML export.

Default setup includes:
- `Reading` -> `Manhua`, `Manhwa`, `Manga`, `Novel` (with subfolders)
- `Watching` -> `Anime` (by genre), `TV Shows`, `Movies`, `Streaming Platforms`
- plus profile-driven major categories (`Programming & Tech`, `Gaming`, `Shopping`, etc.)

## Requirements

- Windows 11
- Node.js 18+ installed
- Google Chrome closed when applying changes

## Files

- `bookmark-sorter.js`: sorter tool
- `bookmark-sorter.config.json`: your category/rule config
- `backups/`: auto-created backup folder when using `--apply`

## Quick Start

1. Open PowerShell in this folder.
2. Run a preview first:

```powershell
node .\bookmark-sorter.js --dry-run
```

3. If the preview looks right, close Chrome completely and apply:

```powershell
node .\bookmark-sorter.js --apply
```

`--apply` now refuses to run if Chrome is open. This prevents Chrome from overwriting your changes.
Use `--force` only if you know what you are doing.

If your profile uses `AccountBookmarks`, direct file writes can be reverted by Chrome account sync.
Use sync-safe export mode instead:

```powershell
node .\bookmark-sorter.js --export-html .\exports\sorted-bookmarks.html --dry-run
```

## One-Command Windows Launcher (.bat)

Use this if you want an interactive profile picker:

```cmd
run-bookmark-sorter.bat
```

What it does:
- Detects Chrome profiles and shows profile names + emails.
- You type profile number(s), e.g. `1` or `1,3`.
- You choose mode: dry-run, export-html, or apply.
- Runs sorting per selected profile.
- Backups are written to `backups\<ProfileFolder>\`.
- HTML exports are written to `exports\`.

Non-interactive examples:

```cmd
run-bookmark-sorter.bat -Selection 1 -Mode dry-run
run-bookmark-sorter.bat -Selection 1 -Mode export-html
run-bookmark-sorter.bat -Selection "1,3" -Mode apply
```

## Profile Support

If your bookmarks are in a non-default Chrome profile:

```powershell
node .\bookmark-sorter.js --profile "Profile 2" --dry-run
node .\bookmark-sorter.js --profile "Profile 2" --apply
```

If `--profile` is omitted, the tool auto-detects Chrome's last-used profile.

Or pass an explicit bookmarks file path:

```powershell
node .\bookmark-sorter.js --bookmarks-file "C:\Users\<you>\AppData\Local\Google\Chrome\User Data\Default\Bookmarks" --dry-run
```

Chrome may store bookmarks as `AccountBookmarks` (newer profiles). That also works:

```powershell
node .\bookmark-sorter.js --bookmarks-file "C:\Users\<you>\AppData\Local\Google\Chrome\User Data\Profile 3\AccountBookmarks" --dry-run
```

## What It Does

- Reads bookmarks from roots in `sourceRoots` (`bookmark_bar`, `other`, `synced` by default)
- Classifies every bookmark by rule order in `categories`
- Builds folder hierarchy in `destinationRoot` (default `bookmark_bar`)
- Places everything under `organizedFolderName` (default `Organized`)
- Writes backup before changes on `--apply`
- Can export sorted results as importable Netscape bookmarks HTML (`--export-html`)

## Sync-Safe Workflow (Recommended for AccountBookmarks)

1. Export sorted HTML:

```powershell
node .\bookmark-sorter.js --profile "Profile 3" --dry-run --export-html .\exports\sorted-Profile3.html
```

2. Open Chrome -> Bookmark Manager -> `Import bookmarks` and choose the exported HTML.
3. Verify imported folders.
4. Remove old unsorted folders manually if desired.

## Rule Matching Basics

Each category can include:
- `keywords`: match in bookmark title or URL
- `domains`: match URL host/domain
- `nameContains`: match title only
- `urlContains`: match URL text only
- `regex`: case-insensitive regex patterns
- `pathContains`: match original bookmark folder path text
- `pathRegex`: regex against original bookmark folder path
- `roots`: match bookmark root (`bookmark_bar`, `other`, `synced`)
- `excludeKeywords`, `excludeDomains`, `excludeNameContains`, `excludeUrlContains`, `excludeRegex`, `excludePathContains`: block noisy matches
- `mode`: `"any"` (default) or `"all"` for combining checks

First matching rule wins (top-to-bottom order in config).

## Customizing Your Categories

Edit `bookmark-sorter.config.json` and adjust folder names/rules.

Example nested structure:

```json
{
  "name": "Watching",
  "children": [
    {
      "name": "Anime",
      "children": [
        { "name": "Isekai", "match": { "keywords": ["isekai"] } },
        { "name": "Romance", "match": { "keywords": ["romance anime"] } }
      ],
      "match": { "keywords": ["anime"] }
    }
  ]
}
```

## Safety Notes

- Always run `--dry-run` first.
- Keep Chrome fully closed for `--apply`.
- Backups are created automatically before writing.
