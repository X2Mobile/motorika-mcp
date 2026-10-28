# Security re-check: main@5a35003 (flow-verifier-max, 2026-10-21)

The reviewer's notes, logs and scripts are in `/tmp/x2b-rev-s2/`: `FINDINGS.md`, `logs/` and `scripts/`.

## Status of the original findings
- **S1, local-file read:** fixed for direct navigation. Every variant is refused:
  - scheme case and whitespace;
  - `file://localhost`;
  - percent-encoding and `..`;
  - symlinked files and dirs;
  - nested `view-source`;
  - `filesystem:`;
  - `about:version`;
  - `chrome://`.

  Iframes and top-frame redirects to a disallowed `file:` are also blocked. The popup channel is still open: see NEW-1.
- **S2, memory:** bounded. 700 × 1 MB of console spam now peaks at 411 MB server RSS (was 1043 MB). A 120k-node DOM peaks at 351 MB (was 611 MB).
- **S3, forged lines:** partly fixed. See NEW-2.
- **S4, hardlinks:** unchanged; nit.

## NEW-1 (critical): a `file:` page inside an allowed root can read any local file through a popup
- **Where:**
  - `src/browser/session.ts:414` (`onNewPage`) and `:429-430` register and activate a popup without checking the URL policy.
  - The reactive guard `src/browser/tabs.ts:252` (`guardLanding`, hooked to `framenavigated` at `:230`) attaches only after the popup page exists, so it never sees the popup's first navigation.
  - `checkNavigation` (`src/util/urls.ts:114`) only runs for `navigate` and `tabs new`.
- **Attack, entirely page-driven:**
  1. An attacker page serves `evil.html` as an attachment. It downloads to `<output-dir>/downloads/evil.html`, which is inside an allowed root.
  2. The page text lures the agent into `navigate file://<output-dir>/downloads/evil.html`. That is allowed.
  3. `evil.html` calls `window.open('file:///…/.ssh/id_rsa')`, or the agent clicks an `<a target=_blank>`.
  4. The popup tab loads the file, and `read` on it returns the key.
- **Evidence:** `logs/dlpivot.log`. A direct `window.open` of an outside file leaked in 3 of 3 runs. The download pivot leaked the dummy SSH key.
- **Fix:** in `onNewPage`, before the popup is registered or activated, check its URL. Apply `guardLanding` for `file:` and `checkNavigation` for internal schemes. If the check fails, report `→ blocked <url> (<reason>)` on the opener, and send the popup to `about:blank` or close it.
  - **Also consider** (main session's note): `<output-dir>/downloads` is filled by pages, so an attacker can write there by design. Excluding it from the `file:` navigation roots, while keeping it as an upload source, closes the pivot at its root.

## NEW-2 (warning): line forging through `\r`, U+2028, U+2029 and NEL
- **Where:**
  - `src/util/format.ts:138-145`: `escapeServerLines` splits on `\n` only.
  - `src/tools/console.ts:14`: `messageText` handles `\r\n`, `\r` and `\n` only.
  - JSON-quoted fields keep U+2028 and U+2029 raw: the snapshot header, the dialog, alert and new-tab effect lines.
- **Evidence:** `logs/forge.log`.
  - In `read` output, `A\r→ navigated …`, `<U+2028>→ navigated`, `<U+2029>hint:` and `<NEL>[t9]` all pass through unescaped.
  - In `console` output, U+2028, U+2029 and NEL pass through.
  - A title containing U+2028 is left raw.
- **Fix:**
  - Treat `\r`, `\n`, U+2028, U+2029, U+0085, `\v` and `\f` as line boundaries everywhere page text is escaped or continued.
  - In JSON-quoted fields, escape U+2028 and U+2029 as ` ` and ` `.

## NEW-3 (warning): a trailing-dot hostname gets past `--blocked-origins`
- **Where:** `src/util/urls.ts:78` (`hostMatches`). The normalized host keeps the trailing dot.
- **Evidence:** `logs/origin.log`. With `--blocked-origins localhost`, the URL `http://localhost.:PORT/` loads. IP literals are fine.
- **Fix:** strip a single trailing dot from the host before matching. The same check is used by the network route, so it covers both paths.

## NEW-4 (nit): the secret scrub matches the literal only
- **Where:** `src/util/secrets.ts:30`.
- **Not redacted:** base64, hex, reversed, space-split and case-changed echoes.
- **Fix:** document that the guarantee covers the literal only. Optionally add a case-insensitive match and a base64 form.

## Sound
- **URL-policy variants:** all refused.
- **Iframes and top-frame redirects:** the guard blocks them.
- **Origin lists:** uppercase and IP forms are handled. The pre-check and the network route both enforce.
- **Hard cap:** holds for `read`, `batch` and screenshots. Image bytes are not counted, by design.
- **Secrets:** the literal and its URL-encoded forms are scrubbed, as are secret-named query parameters and console echoes.
- **`open`:** the new switches add no injection surface.

## Unknown
- Origin lists versus service workers, `sendBeacon`, prefetch, DNS aliases and IDN.
- Headed mode, attach mode, and real-web pages.
- Outbound connections to Google IPs from idle headless Chrome (pre-existing).
