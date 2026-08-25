# Publishing to extensions.gnome.org

## Before uploading

```bash
make check          # lint, schema validation, unit tests
make pack           # refuses to build unless the above pass
```

`make pack` produces `macos-workspaces@inamul07.github.io.shell-extension.zip`.
Upload it at <https://extensions.gnome.org/upload/>. EGO hosts the file itself;
it does not read the git repository.

## Review checklist

Reviewers read the source. These are the things they check, and where this
extension stands on each.

| | Requirement | Where |
|---|---|---|
| ✅ | Everything is undone on `disable()` — signals, keybindings, timeouts, patched behaviour | Verified on hardware: 10 enable/disable cycles, no error, full teardown logged each time. This is the most common cause of rejection |
| ✅ | No `eval`, no downloaded or generated code | |
| ✅ | No `version` key in `metadata.json` — EGO assigns it | `version-name` is ours and is allowed |
| ✅ | `session-modes` is `["user"]` — inactive on the lock screen | `metadata.json` |
| ✅ | The `url` resolves | `github.com/Inamul07/MacOSWorkspaces` |
| ✅ | GPL-compatible licence, present in the repository | `LICENSE`, GPL-2.0, and an SPDX header on every file |
| ✅ | The UUID's domain is one the author controls | `@inamul07.github.io` |
| ✅ | Settings are read at the point of use, so no stale state survives a toggle | `lib/settings.js` |
| ⚠️ | Internal Shell APIs are used | See below |

## The part a reviewer will ask about

This extension takes over `SwipeTracker`'s `begin`/`update`/`end` signals on
`Main.wm._workspaceAnimation`, and replaces four workspace keybinding handlers
through `Main.wm.setCustomKeybindingHandler()`. Both are internal.

There is no public API for any of it: GNOME exposes no way to make a workspace
switch affect one monitor. What makes it defensible is that nothing is
*modified* — the controller's own methods are untouched, so `destroy()`
reconnects them verbatim and the Shell is left exactly as it was found.

Points worth making in the submission notes:

- `checkCompatibility()` runs before anything is touched and bails out cleanly,
  leaving the Shell untouched, if any symbol it depends on is missing.
- The takeover asserts it found **exactly one** stock handler per signal and
  warns loudly otherwise, so a Shell that rewires its signals produces a visible
  warning rather than an extension that silently stops working.
- `shell-version` is `["46"]` only, and deliberately: this has been run on no
  other version. Add versions as each is actually tested — EGO allows updating
  that list without a fresh submission.

## Window movement, and saying so plainly

The extension moves windows between workspaces. That is how per-monitor
workspaces are possible at all under GNOME, and it has a visible consequence:
the Overview, the workspace switcher and Alt+Tab show where a window is parked,
not where it appears. This is documented in the README and in the About page of
the preferences window. Do not let a reviewer discover it for themselves.

The safety properties are worth stating too:

- The primary monitor's windows are never moved.
- It refuses to run under dynamic workspaces, or with fewer than four, and says
  why in the journal.
- `restoreAll()` on `disable()` returns every window to the workspace its record
  says it belongs to.

## After approval

1. Tag the release: `git tag -a v0.1.0 -m 'v0.1.0' && git push --tags`
2. Attach the same zip to a GitHub release, for people who install by hand.
3. Add the new entry to `CHANGELOG.md` under a fresh version heading.

## Updating later

Bump `version-name` in `metadata.json`, run `make pack`, upload again. Each
upload is reviewed. Changing the **UUID** is not an update — it is a different
extension, and every existing user's settings are orphaned, since the UUID is
the settings path.
