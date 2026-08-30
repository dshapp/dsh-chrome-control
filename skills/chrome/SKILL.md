---
name: chrome
description: |
  Drive the user's real Chrome browser — navigate, click, type, read pages, screenshot — using their actual logged-in sessions. Use this skill whenever the user wants to act on a website that needs their login, automate a browser task, or read a page that the harness's own browser cannot reach. Also use when the user says "my browser", "my Chrome", "the tab I have open", or names a site they are signed in to.
---

# Chrome (real browser, real sessions)

These tools drive the **user's own Chrome**, with their cookies and logins, through a local daemon and a browser extension. Tools appear as `mcp__chrome__*`.

## Sessions: one task, one session, one tab group

Every tool takes a required `session`. Pick one name at the start of a task, in kebab-case, describing the **task** and not the site (`flight-compare`, not `united`). Reuse it for every call in that task, even across different sites. Switching names mid-task is the single most common cause of tabs scattering across groups.

On the **first** `navigate` of a task, also pass `group_title` — a short human-readable label in the user's language. Tell the user once that the task's pages are collected under that group and that you will close them whenever they ask.

Only call `close_session` when the user explicitly asks ("close those tabs"). Never close a group on your own initiative.

## The loop

1. `navigate` to open a page (`newTab: true` when pages must coexist).
2. `snapshot` to read it. This returns an accessibility outline, not HTML — one element per line, indented by nesting:

   ```
   heading "Sign in"
   @e46 textbox "Email" val="you@example.com"
   @e50 checkbox "Remember me" [x]
   @e51 button "Sign in"
   ```

   A leading `@e…` is the ref you pass to `click`/`fill`; a line without one is context you can read but not act on. Trailing markers: `[x]`/`[ ]`/`[/]` for checked, unchecked, and mixed, `*` focused, `-` disabled, `×N` for N identical rows collapsed into one.
3. Act with `click` / `fill` using an `@e` ref from that snapshot.
4. `snapshot` with `diff: true` again — it returns only what changed, which is how you confirm the action landed before the next one.

Take a fresh snapshot after anything that changes the page. A ref names the underlying element rather than its position in the outline, so it usually survives an unrelated change — but re-reading is what tells you the action worked. Element resolution already absorbs one re-render race (a brief retry); an error saying **"stale ref — take a new snapshot"** means the element is really gone, so re-snapshot rather than retrying the same ref.

### Snapshot options

- `mode` — `interactive` (default) keeps the controls plus headings, table cells, and images. `full` keeps every node, for when the default has filtered away something you needed. `text` keeps prose and issues no refs.
- `selector` — scope the outline to one container's subtree (an @e ref or CSS selector). The @e ref table is rebuilt from that subtree, so refs outside it go stale.
- `maxDepth` — drop elements nested deeper than this, to see a large page's shape first.
- `diff: true` — return only changes since this tab's previous snapshot: `[+]` added, `[~]` changed, and a trailing `# removed:` line. The first diff has no baseline, so it returns the full tree marked `[+]`. Refs for the whole current page are still published.

When a snapshot comes back too large, narrow it rather than re-reading the whole page: use `selector` to scope one region, `find` to jump straight to one control, and `maxDepth` to see the shape first. If needed, scroll or open only the relevant section before snapshotting again.

On a large page where you want one specific control, `find` is cheaper than a snapshot: give it a plain-language query ("sign in button") and it returns the best-matching `@e` refs. It adds to the ref table rather than replacing it, so refs from your last snapshot stay usable. Use `snapshot` when you need the page's structure, `find` when you already know what you are looking for.

## Prefer @e refs over CSS selectors

`@e` refs identify the element itself, so they survive both the hashed class names of modern frameworks and unrelated edits elsewhere on the page. Reach for a CSS selector only when the target has no ref, and for `evaluate` only when you need something the snapshot cannot express — an attribute like `href`, a scroll, or a complex event sequence.

## Text input

`fill` handles `<input>`, `<textarea>`, and `contenteditable` rich editors (ProseMirror, Lexical, Slate, Quill), firing the input events those editors listen for. It is **clear-and-insert**: existing content is replaced. To append, read the current value with `evaluate`, concatenate, then `fill` the result.

The result echoes what the page kept: `verified: true` means the readback matched, `false` means the framework rejected or reformatted it — check `value` and react. A readonly dropdown input is refused with a pointer to `select`. On a page that re-renders heavily (a docs site remounting its demos), values can be wiped *after* a verified fill; re-check critical fields once at the end.

## Local file upload

Use `upload` for a file input or its visible upload trigger; never use `fill` and do not click merely to open the native picker. Prefer the trigger's `@e` ref from snapshot: the tool follows standard label/ARIA relationships and a uniquely associated input in its container. If several inputs are possible it refuses to guess and asks for a more specific selector. Multiple paths require `multiple`. Re-read the page to confirm acceptance.

## Dropdowns and focus

`fill` cannot drive a dropdown. Use `select` instead — for a native `<select>` **and** for any custom dropdown following the ARIA combobox pattern (`role="combobox"` or `aria-haspopup`), which covers the popular component libraries because they implement the standard. It matches the option's `value` first, then its exact visible text, then a substring, so both `"CA"` and `"California"` can work. When nothing matches, the error lists the visible options — read it rather than guessing again. A custom dropdown is driven with trusted input, so it activates the tab. `select` echoes `verified`; component libraries that render the chosen value outside the combobox (multi-select tags, for example) can report `verified: false` even when selection landed, so re-read with `snapshot({ diff: true })` before concluding it failed.

A control that ignores ARIA gets an error naming the fallback: `click` with `trusted: true`. Multi-level pickers (cascaders, nested menus) are not `select`'s job — walk them level by level with trusted clicks, re-reading the open pane between clicks.

`focus` gives an element keyboard focus without clicking it, for fields that react badly to a click (date pickers that open a popup, inputs that select-all). Follow it with `key_type` or `send_keys`.

## Waiting

Prefer `wait_for_selector`: it polls until an element is visible, or gone with `state: "hidden"`, and returns the moment the condition holds. `navigate` already waits for load, so do not add a blind wait after it.

`wait` is a fixed sleep capped at 3000ms. Reach for it only when there is nothing to wait *for* — a settling animation, a debounce — never as a substitute for `wait_for_selector`.

## Scrolling

`scroll` takes a `direction` ("down" by default) with optional `pixels`, or an explicit `deltaY`. It reports `moved` and `atEnd`, so you can tell an infinite feed from the bottom of the page instead of scrolling blindly. Pass a `selector` to scroll one pane rather than the window.

`scroll_into_view` scrolls an element into view and returns its geometry. Call it before `mouse_click` or `hover`, whose coordinates only mean anything for a visible element.

## Reading page text

To read an article, use `get_text`, not `snapshot`: a snapshot describes structure and controls, while `get_text` returns prose. By default it strips navigation, headers, footers, sidebars, and cookie banners. If that removes something you needed, retry with `raw: true` for the body's verbatim `innerText`. Output is capped (`maxChars`, default 20000) and reports `truncated`.

## Network and dialogs

`network` lists the tab's requests with method, URL, status, and a `requestId`; filter by `method`, `status`, or a URL substring. Use it to find the API call behind a page, or to see why something failed. `network_detail` returns one request's headers, and with `body: true` its response body.

Requests are only recorded from the moment the tools attached to that tab, so a request made during the very first `navigate` may be missing — reload if you need it.

`dialog` answers a native `alert`, `confirm`, or `prompt` with `action: "accept"` or `"dismiss"`, passing `text` for a prompt. **An open dialog blocks every other tool on that tab** — if calls suddenly start timing out after a click, an unanswered dialog is the likeliest cause. Call it only once a dialog is actually open; it errors when there is none.

## Submitting and special keys

Prefer clicking the submit button with `click`. When there is no button, use `send_keys` with `Enter`. `send_keys` also takes chords such as `Control+A` or a bare `Escape` to dismiss a modal.

## When a page ignores clicks

`click` dispatches the full synthetic pointer stroke (pointerdown → mousedown → pointerup → mouseup → click), which most widgets accept. Some pages (banking portals, captchas, widgets that check `event.isTrusted` or listen outside the DOM event path) still ignore it. Escalate in this order:

1. `click` with `trusted: true` — real browser input at the element's center, still addressed by `@e` ref or selector. This is the normal fallback.
2. `mouse_click` with a `selector` — same trusted click; use it when you also want the button/clickCount options.
3. `mouse_click` with raw `x`/`y` — last resort; coordinates are far more brittle than `@e` refs.

Also trusted: `hover` (menus and tooltips that only open on hover), `key_type` (type into whatever is focused), `send_keys` (press one key or chord). All trusted input activates the tab.

A trusted click refuses rather than guessing when the target is not safely clickable: `disabled`, `hidden`, `zero-size`, `outside-viewport`, `pointer-events`, `obscured`, or `stale`. The error names the reason and the element actually under that point (`hit target: ...`), so treat it as real page state — scroll, dismiss the overlay, or wait for the control to become enabled — not as a tool glitch. It never falls back to blind coordinates.

## Screenshots

`screenshot` returns the image directly, so you can simply look at it. Pass `selector` to capture one element, or `format: "jpeg"` with `quality` to shrink a large capture.
prefer snapshot over screenshot use screenshot when snapshot not work.

## Evaluate tips

- Return compact data. Use `JSON.stringify(value)` without indentation — pretty-printing inflates a large result until it is truncated.
- Calls share the page's JavaScript realm, so re-declaring the same `const` twice throws. Wrap each call's body in an IIFE: `(() => { const x = 1; return x })()`.

## Reading the user's open tab

To act on a page the user is already looking at ("the invoice I have open"), call `find_tab` with `active: true`. That borrows the tab they are viewing rather than opening a new one. Otherwise `find_tab` takes a full `url` and searches this session's own tabs.

`list_tabs` lists every tab in the session's group and flags the one the page tools currently act on with `current: true`; switch with `find_tab`. Tabs opened with `navigate({newTab: true})` all join the same group.

## Known limits

- **Cross-origin iframes**: tools act on the top frame. If the target lives in an iframe from another origin, navigate directly to the iframe's URL.
- **Trusted input activates the tab.** `hover`, `mouse_click`, `key_type`, and `send_keys` bring their tab to the foreground, because Chrome only delivers real input to a focused tab. The DOM-level tools work fine on a hidden tab.
- **Network history starts at attach.** `network` cannot show requests made before the tools attached to that tab.
- **A debugging banner is normal.** Chrome shows a "being debugged" notice while these tools are attached, and DevTools cannot be open on the same tab at the same time. This is how the bridge works, not a fault — mention it if the user is surprised.

## When a tool fails

The error text names the fix. Two cases matter:

- **"No Chrome extension is attached"** — Chrome is closed, the extension is not loaded, or its popup toggle is off. Ask the user to open Chrome, load the extension at `chrome://extensions` (Developer mode → Load unpacked), and check the toggle in its popup. Do not try to install it yourself; loading an unpacked extension is the browser owner's decision.
- **The tools are missing entirely** — the `dsh-chrome-control` plugin did not load in the Web profile. Ask the user to check that the plugin is installed and restart `dsh web`; the bridge now lives on that same server at `/chrome/mcp` and `/chrome/ws`, with no separate daemon process.
