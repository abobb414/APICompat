<p align="center"><a href="./README.md">简体中文</a> | <b>English</b></p>

# APICompat

A browser-side model API compatibility probe. Single-file, zero-backend, zero-build: fetch the target site's model list, probe it protocol by protocol, and export the results.

## Engineering Scope

- 10 protocols: OpenAI Chat, Anthropic, Responses, native Google, Google OpenAI, DashScope, Azure, Ollama, Cohere, and Custom.
- 11 failure attributions: HTTP errors, missing models, unsupported protocols, unavailable channels, timeouts, CORS, and related cases are separated.
- Multi-round sampling: 1–5 samples per cell; latency uses the median and status uses the mode.
- Metering mode: keep reading after the first chunk and record output speed; normal probing stops after the first valid chunk.
- Exports: HTML, Markdown, JSON, and CSV, with the measurement setup included.
- Theme toggle: light / dark only. The sun and moon are repository-owned SVG masks; no external project or remote asset is required.

## Key Decisions

### Parse the response before calling it successful

HTTP 200 is not a success criterion. Each protocol parses its own response shape:

| Protocol | Success criterion |
|---|---|
| OpenAI | A valid content chunk is parsed from `choices[]` |
| Anthropic | Content is parsed from `content[]` or streaming events |
| Google | `candidates[].content.parts[]` |
| Ollama | `message` inside NDJSON |
| Cohere | `content-delta` |
| Custom | Supported response shapes are tried in sequence |

A reasoning model may spend the whole `max_tokens` budget thinking, leaving the final body empty while the response is valid. Success cannot depend only on non-empty final text.

### Retries must expose their cost

Retry network failures, timeouts, and 5xx responses. Do not retry deterministic failures such as 401, 403, 404, or unsupported protocols. A cell that succeeds after a retry keeps its first status, first latency, backoff wait, and attempt count, so a long timeout is not disguised as a fast success.

### Concurrency needs a ceiling

The probe uses six concurrent lanes instead of an unbounded `Promise.all`. As model and protocol counts grow, a burst can trigger upstream 429 responses and turn the result into a rate-limit measurement.

### Theme state and first paint

`data-theme` has only `light` and `dark`. On a first load with no saved choice, the page reads `prefers-color-scheme`; after that it stores the user's choice in `localStorage`. The theme is applied synchronously in `<head>`, while CSS variables, `color-scheme`, and `theme-color` are updated together.

Theme icons live at `assets/icons/theme-sun.svg` and `assets/icons/theme-moon.svg`. CSS masks reference these local files and follow `currentColor`. The button contains only the icon, with no outline or disc behind it.

## Browser Boundary

The API key never passes through a project server; the browser requests the target directly. The target must therefore allow CORS. mTLS, custom TCP, client certificates, and other browser-inaccessible request types are out of scope.

## Tests

`tests/mock.py` uses only the Python standard library to simulate 16 models × 10 protocols, including declaration/measurement mismatches, fixed 404s, intermittent 500s, and streamed text chunks.

```bash
# start the mock, run Playwright assertions, and clean up
bash tests/run.sh

# manual run
python3 tests/mock.py 8788 &
node tests/smoke.mjs
```

The suite is **50 passed / 0 failed**. It covers model-list fetching, matrix and stat consistency, protocol response parsing, retry cost, four exports, overflow at 390/768/1024px, `file://` opening, the two-state theme, multi-round sampling, and metering mode.

## Engineering Notes

### 1. A small `max_tokens` misclassifies reasoning models

The first version treated non-empty final text as success and marked reasoning models as failures. The fix was to parse valid chunks per protocol instead of depending on final text length.

### 2. `nowrap` can break the mobile grid

A single-line ellipsis for protocol paths let `max-content` width contribute to the grid item's automatic minimum size, producing horizontal overflow at 390px. The container now uses `minmax(0, 1fr)` and allows the path to wrap when needed.

### 3. Missing endpoints can return homepage HTML

Looking only at the status code turns `200 + HTML` into an apparent model list. The parser detects HTML bodies and reports a page response instead of an API response.

### 4. Theme assertions must wait for transitions

Reading computed styles immediately after a theme click samples the transition frame and falsely reports bright leftovers. The test waits for the transition to settle before checking the final state.

### 5. Assertions must follow DOM changes

After the retry tooltip moved to the cell wrapper, the old assertion kept reading `title` from the marker and got an empty value. Assertions should target the node that owns the current semantic, not an old DOM level.

### 6. Distinguish bool from uint8 when tracing masks

`potrace` treats dark pixels as foreground while an alpha mask commonly uses bright pixels for foreground, so the mask must be converted to bool before applying `~`. Applying `np.invert` directly to a 0/1 uint8 mask yields 254/255, which can silently produce a full canvas or an empty path.

## Limitations

- CORS failures and unreachable networks can look identical from the browser.
- Latency is end-to-end first-chunk time over the current network path, not server-internal time.
- The matrix describes one run; channels, quotas, and model status change.
- Multi-round sampling multiplies the request count by the sample count.
- The project stores no history; export JSON if you need trend comparisons.
