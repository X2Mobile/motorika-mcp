# Security defaults

What the server refuses, redacts and marks by default, and exactly what is not covered. Back to the [README](../README.md).

- **Upload sources** must resolve, by realpath with symlinks followed, inside an allowed root.
  - The default roots are the process cwd, `<output-dir>`, `~/Downloads`, `~/Desktop` and
    `~/Documents`. `--allow-file-root` adds roots.
  - A dot-file or dot-dir is refused unless `--allow-hidden-files`. The check applies to the path
    relative to the root that contains it, both as given and after realpath, because the default output
    root itself lives under `~/.motorika`.
  - Each refusal names the flag that would widen it.
- **Written files** (screenshots, downloads) go only inside `<output-dir>`. Their names are sanitised: no
  separators, no `..`, no leading dot, at most 120 chars.
- **Password values** never appear in snapshot, find, fill_form, effect summaries or errors. A filled
  password field shows `value=<redacted>`. Typed text is never echoed. A value the server typed into a
  password field is remembered for the life of the process and printed as `<redacted>` in every result
  where a page echoes it: `read` text and links, console messages, `evaluate` results, snapshot text and
  values, `find`, `network`, `tabs`, effect lines, error messages and every printed URL.
  - **What is remembered:** literals of 6+ characters, at most the 64 most recent. A literal equal to a role
    word or a ref id (`button`, `e12345`) is not remembered, so the output grammar stays intact.
  - **Spellings covered:** the literal; percent-encoded, each character written raw or as the `%XX` escapes
    of its UTF-8 bytes (hex in either case), in any mix, as Chrome, `encodeURIComponent` or a form writes it
    (`O%27Brien!26`, `p@ss%20word`, `%48unter2xZ`); a space written `+` (a `+` and a space count as the same
    character); JSON-escaped, as a JSON string prints it (`Hu\"nt\\er2!`), an emoji as a surrogate-pair
    escape included (`Smile\ud83d\ude0042`, as Python's `json.dumps` writes it); and JSON-escaped and
    percent-encoded characters mixed, as a Chrome URL prints inside a JSON string (`Hu%22nt\\er2!`).
  - **Whole tokens only:** no letter or digit directly before or after it. A `%XX` escape next to it is an
    edge whatever it decodes to (`?q=%27<redacted>%27`, `%41<redacted>`), and so is a JSON escape
    (`\n<redacted>`) and another redaction: a secret that touches or overlaps a redacted one is redacted too,
    in any order of remembering (`%27Hunter2%C3%A9Zebra99!%27` prints `%27<redacted>%27`), and overlapping
    ones merge into one `<redacted>`. A secret glued to a letter or digit stays as it is, by design:
    `xHunter2xZ`, and also two secrets glued to each other with no edge between them (`Hunter2xZebra99!`).
  - **A redaction never splits an escape or a quoted string:** a match that starts or ends inside a `%XX`
    escape takes the whole escape (the secret `7Hunter2xZ` in `%27Hunter2xZ` prints `<redacted>`); a match
    that would start or end inside a JSON escape is left alone (`\nopass12` for the secret `nopass12`); and a
    `"` that opens or closes a JSON string reaching outside the redaction is kept, so a secret ending in `"`
    never ends a quoted name early.
  - **Not covered:** base64 or any other encoding, a changed case, a secret split across elements, double
    percent-encoding (`%2527`), a `"` or `\` escaped twice (a JSON string inside a JSON string), a page's
    non-UTF-8 charset (a GET form on a windows-1252 page prints `P%E4ssw%F6rd1`), and, for a secret that
    itself holds more than four `%XX`-like or backslash sequences or is longer than 128 characters, a mix of
    those sequences written raw and escaped (all raw or all escaped is covered).
- **Printed URLs** (headers, `→ url`, `→ navigated`, `→ new tab`, `→ blocked`, tabs, network, console
  locations, errors that name a URL, `href=`) are matched the same way on the raw URL, before the server
  percent-encodes it (without JSON escapes: a URL is raw text). A `<redacted>` in a printed URL is always the
  server's: the same text from a page prints as `%3Credacted%3E`. `href=` is the exception: it is page
  content inside a JSON string and is not percent-encoded, so a page's own `<redacted>` text can appear
  there. In printed URLs,
  query parameters whose name contains `pass`, `password`, `passwd`, `pwd`, `secret`, `token`,
  `api-key`/`api_key`/`apikey` or `auth` as a word part (separated by `_`, `.`, `-`, `[` or `]`, so
  `user[password]` too) show `<redacted>` values; `author` and `passengers` are left alone. A URL inside
  quoted page text ends at a backslash, so redaction never eats the `\` of an escaped quote. Where a remembered
  secret is redacted inside a URL in page text (a `read` link, a console message, an `evaluate` result), the same
  scrub also redacts that URL's secret-named parameters, the ones after the secret included
  (`?q=%27<redacted>%27&token=<redacted>`), and those of a URL glued right after it
  (`!<redacted>!http://b.test/?token=<redacted>`). Not seen by these rules: a secret-named parameter inside
  another parameter's value (`?next=http://b.test/?token=…`), a URL glued to a letter or digit (`xhttp://…`), and
  one after a quote, backslash or space that ends the URL in text (unless a redacted secret holding that character
  bridges it).
- **Network detail** redacts the values of `authorization`, `proxy-authorization`, `cookie`, `set-cookie`,
  `x-api-key` and `x-auth-token`.
- **Untrusted content:** page-derived text is marked `(untrusted page content)` in snapshot, read, find,
  console, network and evaluate results.
- **Debugging port:** launch modes open no TCP debugging port.
- **evaluate** is enabled and annotated `destructiveHint`.
- **Network traffic:** no telemetry, and no network traffic besides the browser's own.
