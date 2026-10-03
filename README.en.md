<p align="center"><a href="./README.md">简体中文</a> | <b>English</b></p>

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/images/logo-white.png" />
  <img src="./docs/images/logo.png" alt="APICompat" width="124" />
</picture>

# APICompat

**Ask the server for its model list first, then test that list protocol by protocol · a zero-build / zero-dependency / zero-backend single-file static site**

Not "guess which model works", and not "paste one curl and see if it goes through" —
it pulls down the model list the site exposes, then runs a cross matrix over **10 protocols × every model**,
giving a status and a first-chunk latency per cell, and finally exports a diagnostic report you can send to someone.

[![Live Demo](https://img.shields.io/badge/Live_Demo-apicompat.abobb.site-2f80ed?style=flat-square&logo=icloud&logoColor=white)](https://apicompat.abobb.site)
[![No Build](https://img.shields.io/badge/build-none_required-3fb950?style=flat-square&logo=html5&logoColor=white)](#quick-start)
[![Dependencies](https://img.shields.io/badge/dependencies-0-3fb950?style=flat-square&logo=javascript&logoColor=white)](#project-structure)
[![Protocols](https://img.shields.io/badge/protocols-10-8b5cf6?style=flat-square)](#protocol-matrix)
[![States](https://img.shields.io/badge/states-11_attributions-f59e0b?style=flat-square)](#the-eleven-states)
[![Single File](https://img.shields.io/badge/single_file-146_KB_%C2%B7_2731_lines-64748b?style=flat-square)](#project-structure)

[Live Demo](https://apicompat.abobb.site) · [Preview](#preview) · [Protocol Matrix](#protocol-matrix) · [Test Flow](#test-flow) · [Quick Start](#quick-start) · [Engineering Notes](#engineering-notes-the-pitfalls)

</div>

---

## Preview

> Screenshots come from the live version. **The result matrix and report shots were staged against a local `tests/mock.py`** —
> 16 models, 10 protocols, 160 combinations, with real requests and real timing,
> only the upstream swapped for a fake relay, so no real quota got burned just for screenshots. The hero and mobile shots are the live site as-is.

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/hero.jpg" alt="Config panel">
      <br><sub><b>Config panel</b> · enter the base URL + key, tick the protocols to test. Each of the 10 cards labels the endpoint it hits</sub>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/matrix.jpg" alt="Result matrix">
      <br><sub><b>Result matrix</b> · model × protocol, a status and first-chunk latency per cell; the "server-declared" column flags models where the declaration doesn't match the measurement</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/screenshots/detail.jpg" alt="Cell detail">
      <br><sub><b>Cell detail</b> · click any cell to see the actual request URL, the response mode, the first-chunk latency, and whether that cell needed a retry</sub>
    </td>
    <td width="50%" valign="top">
      <img src="docs/screenshots/report.jpg" alt="Diagnostic report">
      <br><sub><b>Diagnostic report</b> · protocol pass rate, fully unusable / fully passing, declared vs. observed mismatches, recommended picks</sub>
    </td>
  </tr>
</table>

<div align="center">

<img src="docs/screenshots/mobile.jpg" width="34%" alt="Mobile">

<br><sub><b>Mobile</b> · collapses to a single column at 390px; the matrix scrolls sideways with the model column frozen</sub>

</div>

---

## Table of Contents

- [What It Solves](#what-it-solves)
- [Protocol Matrix](#protocol-matrix)
  - [The Ten Protocols](#the-ten-protocols)
  - [The Eleven States](#the-eleven-states)
- [Test Flow](#test-flow)
- [Features](#features)
  - [Fetch the list first, then test](#fetch-the-list-first-then-test)
  - [First-Chunk Latency: The Bar for "Usable"](#first-chunk-latency-the-bar-for-usable)
  - [Timing Scope and Retries: Two Numbers That Have to Be Stated Plainly](#timing-scope-and-retries-two-numbers-that-have-to-be-stated-plainly)
  - [Declared ≠ Observed](#declared--observed)
  - [Base URL Normalization: Whatever You Paste Works](#base-url-normalization-whatever-you-paste-works)
  - [Four Export Formats](#four-export-formats)
- [Quick Start](#quick-start)
- [Deployment](#deployment)
- [Project Structure](#project-structure)
- [Implementation Notes](#implementation-notes)
- [Tests](#tests)
- [Engineering Notes: The Pitfalls](#engineering-notes-the-pitfalls)
- [Limitations](#limitations)

---

## What It Solves

Third-party relays (the new-api / one-api kind) are everywhere now, but getting a straight answer about what they support is hard:

| Common approach | Where it breaks down |
|---|---|
| Read the site's docs | It says "OpenAI / Claude / Gemini compatible" but never says **which model** takes which route |
| Try one model once | It only proves **this one model × this one protocol** works; change the model or the protocol and it may all fall apart |
| Look at the `/v1/models` list | It only proves the endpoint exists, **not that any single model can actually answer** |
| Read `supported_endpoint_types` | Declarations often disagree with reality — the declaration is a handful, the measurement usually gets several more through |

This tool ties those four things into one: **list + matrix + timing + report**.

> **Why does it have to be pure front-end?** Because it uses your API key to hit your own upstream.
> Put any server in the middle and the key has to leave your browser first.
> There is no backend here — the page comes from static hosting, and from then on every request goes straight from your browser to the target site,
> so your data never leaves the machine. The cost is explicit: **the target site must allow cross-origin requests**, otherwise the browser blocks it (see [Limitations](#limitations)).

## Protocol Matrix

### The Ten Protocols

Basically every compatibility shape you meet in the wild is here. **Each one sends its requests independently, along its own path and with its own auth headers**,
not "hit them all as if they were OpenAI":

| | Protocol | Request endpoint | Auth | Notes |
|---|---|---|---|---|
| 1 | `openai` | `POST /v1/chat/completions` | `Authorization: Bearer` | The de-facto standard, supported almost everywhere |
| 2 | `anthropic` | `POST /v1/messages` | `x-api-key` + `anthropic-version`, **plus an extra `Authorization`** | Claude Code / cc-switch take this route |
| 3 | `openai-response` | `POST /v1/responses` | `Authorization: Bearer` | The new Responses API; content lives in `output[]` |
| 4 | `google` | `POST /v1beta/models/{model}:streamGenerateContent?alt=sse` | `x-goog-api-key` | AI Studio native format; falls back to non-streaming `:generateContent` if that fails |
| 5 | `google-openai` | `POST /v1beta/openai/chat/completions` | `x-goog-api-key` | The OpenAI compatibility layer Google ships |
| 6 | `dashscope` | `POST /compatible-mode/v1/chat/completions` | `Authorization: Bearer` | The compatibility path for Bailian / Qwen |
| 7 | `azure` | `POST /openai/deployments/{model}/chat/completions?api-version=2024-02-01` | `api-key` | The deployment name goes in the path, not the body |
| 8 | `ollama` | `POST /api/chat` | none | Local service; replies with **NDJSON, not SSE** |
| 9 | `cohere` | `POST /v2/chat` | `Authorization: Bearer` | Cohere Chat v2 |
| 10 | `custom` | **request sent as-is, no path appended** | `Authorization: Bearer` | Catch-all for proxy layers that handle protocols themselves; the response format is auto-detected |

> Why does the `anthropic` row **send the key twice**? We've measured sites that only accept `x-api-key` and sites that only accept `Authorization`;
> sending both is the widest-compatibility option right now, at the cost of one extra header field.

### The Eleven States

"Failed" isn't enough information — a red cross might mean your key is wrong, or that this model has no channel in the free group.
So every cell lands in one of 11 states. They're listed below by their **internal key** — the UI and the exported report render the label in Chinese:

| State | How it's decided | What you should do |
|---|---|---|
| **OK** | A valid streaming chunk arrived | — |
| **WARN** | The request succeeded, but no valid chunk was parsed | Retry with a larger `max_tokens` |
| **TIMEOUT** | No first chunk within the configured timeout | Raise the timeout or switch protocol |
| **RATELIMIT** | HTTP 429 | Check your quota or lower the concurrency |
| **NOCHANNEL** | HTTP 503, or the body contains "无可用渠道 / no available channel / distributor" | This model really has no channel in the current group — not your problem |
| **NOTFOUND** | HTTP 404, or 400 with a body containing "not found / does not exist / 不包含" | The model name is misspelled |
| **UNSUPPORTED** | The body contains `unsupported_endpoint` / `not implemented` / `convert_request_failed` / `不支持` | This route doesn't work — try another |
| **UNAUTH** | HTTP 401 / 403 | The key expired or was banned |
| **NETWORK** | `fetch` throws outright (not an abort from a timeout) | The site doesn't allow CORS, or the address is unreachable |
| **SERVER** | HTTP 5xx | The upstream itself is down — retest later |
| **UNKNOWN** | Anything else | Open it and read the raw response |

> This classification is **order-sensitive**: 401/403 first, then 404, 429, 503,
> and only then the body keywords. Plenty of relays tuck "model not found" inside a 400,
> so looking at the status code alone would label them all `UNKNOWN`.

## Test Flow

```mermaid
flowchart TD
    A["Base URL + key<br/>normalizeBase() splits out origin and candidate root"] --> B["Phase 1 · Fetch the list<br/>try up to 6 endpoint candidates in order"]
    B --> C{"Got a model array?"}
    C -->|"yes"| D["Phase 2 · Cross-test<br/>model × protocol · concurrency pool"]
    C -->|"no"| E["Attribute to one of 11 states<br/>and suggest a matching fix"]
    D --> F{"Chunk parsing"}
    F -->|"first valid JSON chunk"| G["OK<br/>record first-chunk latency"]
    F -->|"HTTP 4xx / 5xx"| H["classifyHttp()<br/>status code + body keywords"]
    F -->|"abort"| I["TIMEOUT<br/>can be retested on its own"]
    G --> J["Matrix + stats bar + diagnostic report"]
    H --> J
    I --> J
    J --> K["Export HTML / Markdown / JSON / CSV"]

    style A fill:#0ea5e9,color:#fff
    style B fill:#8b5cf6,color:#fff
    style C fill:#f59e0b,color:#fff
    style D fill:#8b5cf6,color:#fff
    style E fill:#ef4444,color:#fff
    style F fill:#f59e0b,color:#fff
    style G fill:#22c55e,color:#fff
    style H fill:#64748b,color:#fff
    style I fill:#64748b,color:#fff
    style J fill:#334155,color:#fff
    style K fill:#22c55e,color:#fff
```

The list endpoint isn't a single attempt either. Candidates are tried in order, and whichever returns valid JSON first wins:

```mermaid
flowchart LR
    A["{origin}/v1/models<br/>Bearer"] --> B["{origin}/models<br/>Bearer"]
    B --> C["{origin}/v1/models<br/>x-api-key"]
    C --> D["{origin}/v1beta/models<br/>x-goog-api-key"]
    D --> E["{origin}/api/tags<br/>no auth"]
    E --> F["Manual list<br/>fill it in line by line under advanced options"]

    style A fill:#0ea5e9,color:#fff
    style B fill:#0ea5e9,color:#fff
    style C fill:#8b5cf6,color:#fff
    style D fill:#8b5cf6,color:#fff
    style E fill:#8b5cf6,color:#fff
    style F fill:#64748b,color:#fff
```

> The bar is "**does the response contain a model array**", not "HTTP 200".
> Some sites return 200 plus an HTML homepage for unknown paths; those are always treated as unsupported,
> and it says so outright — "returned an HTML page, not an API" — otherwise you'd quietly end up with an empty list.

## Features

| | Feature | In one line |
|---|---|---|
| 🔎 | **List first, test second** | Pull the visible models from the site, then verify them protocol by protocol, instead of typing model names by hand |
| 🧩 | **Ten protocols, ten independent request shapes** | Paths, auth headers and body shapes all follow each protocol's own rules, instead of an OpenAI template |
| ⏱ | **First-chunk latency only, never a faked total time** | Streaming aborts on the first chunk so it burns no tokens — no total time for streaming; non-streaming gets response time |
| 🎯 | **Eleven-state attribution** | Tell "your key is broken" apart from "this model has no channel" |
| ⚖️ | **Declared vs. observed, side by side** | Put `supported_endpoint_types` next to what actually got through; flag mismatches in yellow |
| 🚀 | **Tunable concurrency / timeout / retries** | 6 concurrent by default; measured to be an order of magnitude faster than serial |
| ↻ | **Retry cost on display** | Cells that only passed after a retry carry ↻, with the first attempt's duration and backoff spelled out |
| 🔁 | **Retest failures only** | A flaky upstream doesn't force a full rerun |
| 📊 | **Four export formats** | HTML (send it straight to someone) / Markdown (paste into an issue) / JSON (feed to scripts) / CSV |

### Fetch the list first, then test

Typing model names by hand is the easiest step to get wrong — one character off and the result is `NOTFOUND`,
with no way to tell whether the name was wrong or the site simply doesn't have it.

So the flow is reversed: **GET the list first, then use the returned ids verbatim**.
If the list carries `supported_endpoint_types`, that gets its own column in the matrix;
tick "only test declared protocols" and you can cut the combinations from 160 down to a few dozen, saving time and quota.

### First-Chunk Latency: The Bar for "Usable"

The probe sends streaming requests (`stream: true`), but **"we got the first byte" is not the success bar**:

| Approach | Problem |
|---|---|
| Status code only | Some sites return 200 first and then spit an error into the stream |
| "There are bytes" only | Heartbeats and empty SSE comments get counted as success |
| **"Did a valid JSON chunk parse"** | ✅ this is the one we use |

Reasoning models have a trap: with too small a `max_tokens`, they spend it all on thinking and return an empty string as the content.
Checking "content is non-empty" would misjudge them as failures, so the bar stops at **whether the chunk is valid**,
and `max_tokens` is set to 512 to leave headroom.

### Timing Scope and Retries: Two Numbers That Have to Be Stated Plainly

**Streaming only reports first-chunk latency.** The probe calls `abort()` the moment it parses the first valid chunk
(otherwise every test quietly burns 512 tokens), which means that instant is both "the first chunk arrived"
and "the request ended". Printing it as "total time" is a lie — the same number cannot be both the start and the end. So:

- a streaming cell reports first-chunk latency only, and the detail popup says
  "streaming: aborts on the first data chunk, so total time is not measured";
- non-streaming responses (which arrive in one piece) get "response time", labelled as such.

**A retry has to be reported together with what it cost.** The default retry count is 1, and after a successful retry
the tool holds the result of the **last** attempt: if the first one hit a timeout (possibly a full 30 seconds)
and the retry succeeded in 200 ms, the cell would show nothing but a pretty 200 ms.
That is the same trick as "retry until success and only display the successes", so now:

- a cell that only passed on retry carries a **↻** marker, and hovering shows the first attempt's status and duration;
- the detail popup lists "attempts", "first attempt" and "backoff wait";
- the completion banner separately reports "N usable combinations only passed after a retry";
- the JSON export carries `attempts` / `retried` / `retryWaitMs` / `firstAttemptMs`.

> In one line: the latency in a cell comes from the attempt that succeeded, but **the cost paid before the retry is never hidden**.

### Declared ≠ Observed

This is the most interesting column in the tool. The server's `supported_endpoint_types` is the declaration,
the green cells in the matrix are the measurement — when the two disagree, they get listed separately:

- **Declared supported but not usable** — `anthropic` is in the declaration, but a real request comes back 400
- **Not declared but usable anyway** — only `openai` was declared, yet the `dashscope` compatibility path works too

> Drift like this is common on relays, because they only route by "model group",
> and many models are really aliases of the same upstream. **Measurements beat declarations**, but don't rush to a conclusion —
> hit "retest failures" first; upstream flakiness is more frequent than you'd think.

### Base URL Normalization: Whatever You Paste Works

When you copy a URL out of some docs, the clipboard can hold just about any shape. All of these get stripped down before testing:

| What you paste | What actually gets tested |
|---|---|
| `https://api.example.com` | tries both `/v1/chat/completions` and `/chat/completions` |
| `https://api.example.com/v1` | joins under `/v1` |
| `https://api.example.com/v1/chat/completions` | strips the trailing protocol path and falls back to the origin |
| `https://api.example.com/v1beta/models` | same as above; `/models` gets stripped |
| `https://xxx.com/openai/deployments/gpt-4/chat/completions` | stripped to the origin; the Azure row builds its own path back up |
| `https://api.example.com/#/` | drops everything after `#` first |

### Four Export Formats

| Format | What it's for |
|---|---|
| **HTML** | A self-styled one-page report you can send straight to someone |
| **Markdown** | Paste into an issue / PR / group chat; tables keep their shape |
| **JSON** | Feed to scripts for trend comparison |
| **CSV** | Drop into spreadsheet software to sort and filter |

All four formats carry the same disclaimer, and the report footer also records which site was tested and when.

## Quick Start

**No `npm install`, no bundling, no dependencies whatsoever.** One file, double-click and go:

```bash
# serve it properly (recommended; some browsers restrict fetch harder under file://)
python3 -m http.server 8788
# then open http://127.0.0.1:8788
```

You can also just double-click `index.html` — the styles, scripts, icons and favicon are all inlined in that one file.

Using it takes three steps:

```text
1. Fill in the Base URL and API Key   →  https://your-relay.example.com/v1
2. Tick the protocols to test (the three most common are ticked by default: OpenAI Chat / Anthropic Messages / OpenAI Responses)
3. Click "probe all protocols"  →  watch the matrix fill in cell by cell
```

> ⚠️ **Do create a fresh, low-quota key for this**, and delete it right after.
> A full-protocol probe sends one request per model × protocol,
> which runs into the hundreds of calls when you have many models — using your main key against a production account is not a good idea.

## Deployment

A purely static artifact — drop it anywhere:

| Platform | Configuration |
|---|---|
| **Vercel** | Framework Preset `Other`; leave Build Command and Output Directory empty |
| **Cloudflare Pages** | Leave the build command empty, set the output directory to `/` |
| **GitHub Pages** | Settings → Pages → Source: pick the branch root |
| Local | `python3 -m http.server`, or just double-click |

The live copy runs on Vercel behind the `apicompat.abobb.site` domain:

```bash
# the project root is the deployable artifact
vercel deploy --prod
```

## Project Structure

```
.
├── index.html              # everything — styles, logic, vector icons and favicon all inlined, 146 KB / 2731 lines
├── robots.txt
├── docs/
│   ├── images/
│   │   ├── logo.png        # README header (light theme)
│   │   └── logo-white.png  # README header (dark theme)
│   └── screenshots/        # README screenshots
└── tests/
    ├── mock.py             # fake relay: 16 models × 10 protocols, Python standard library only
    ├── smoke.mjs           # end-to-end assertions (Playwright)
    └── run.sh              # start mock → run assertions → done
```

**Having only one `index.html`** is deliberate: hand it to a colleague, drop it on a USB stick, attach it to an email — no directory to carry along.
The price is that the file can't afford to grow fat — every icon was converted to vectors and inlined as a CSS mask,
and the 14 icons come to 16.6 KB, three-quarters smaller than the same set as PNGs, and crisp at any scale.

## Implementation Notes

- **The bar is "a valid chunk parsed", not "HTTP 200"**: the `ok` / `text` function families are written per protocol,
  each recognizing its own response shape (OpenAI's `choices[]`, Anthropic's `content[]`,
  Gemini's `candidates[].content.parts[]`, Ollama's NDJSON `message`, Cohere's `content-delta`),
  while the `custom` protocol tries all six shapes in turn.
- **The concurrency pool is a hand-written 6 lanes**, not a `Promise.all` free-for-all —
  `Promise.all` would fling hundreds of requests out at once, the upstream would rate-limit immediately, and everything would come back 429.
- **Only "worth retrying" gets retried**: network blips, timeouts and 5xx are retried with backoff;
  deterministic failures like 401 / 404 / unsupported protocol are not, saving time and quota.
- **Anything read out of `localStorage` is sanitized as untrusted input**: the key is only persisted when "remember" is ticked,
  and corrupted config must never be allowed to break the page.
- **16.6 KB of vector icons**: bitmaps were traced into `path` with potrace and used as CSS masks
  (`background-color: currentColor`), so colors follow the theme automatically — smaller and sharper than bitmaps.
  The key setting is **no supersampling** — trace at the original resolution; supersampled 4× the same 14 icons would take 81 KB.
- **Only 4 font sizes**: 11 / 13 / 15 / 20px; hard-coded `font-size` across the site is down to zero,
  and the standalone stylesheet in exported reports shares the same set.

## Tests

`tests/mock.py` starts a fake relay (**16 models × 10 protocols, Python standard library only, zero dependencies**),
and deliberately keeps a few shapes you meet in the real world: declarations that disagree with measurements, three endpoints that always 404,
and a different first-chunk latency range per protocol. That way the whole chain can run **without burning any real quota**.

```bash
# one shot: start mock → run assertions → clean up
bash tests/run.sh

# or manually
python3 tests/mock.py 8788 &
node tests/smoke.mjs

# or run it against the live site (only checks the hero and rendering, sends no probe requests)
BASE=https://apicompat.abobb.site node tests/smoke.mjs
```

Coverage falls into these buckets: hero rendering and icon mounting, list fetching, matrix dimensions and stats consistency,
the cell-detail popup and its timing scope, **retry cost made visible**, the "only usable protocols" filter,
the four exports being non-empty, no horizontal overflow at the 390 / 768 / 1024 breakpoints,
and double-click opening over `file://`.

**32 assertions in total; against `tests/mock.py` it's 32 passed / 0 failed.**

```
PASS  page loads with no console errors
PASS  renders 10 protocol cards
PASS  only the 3 main protocols are ticked by default
PASS  every icon gets its vector mask
PASS  footer carries the low-quota key warning and the disclaimer
PASS  full-protocol probe finishes
PASS  model list fetched (16 visible models)
PASS  matrix row count = model count
PASS  matrix column count = models + declared + 10 protocols
PASS  matrix cells = 16 × 10
PASS  stats bar "total combinations" is self-consistent
PASS  usable combinations exist and match the stats
PASS  legend has all four colors
PASS  diagnostic report generated (with protocol pass rate and conclusion analysis)
PASS  clicking a cell opens the detail popup (with first-chunk latency and timing scope)
PASS  the detail popup no longer mislabels first-chunk latency as "total time"
PASS  "only usable protocols" filter applies and can be undone
PASS  HTML export is non-empty
PASS  Markdown export is non-empty
PASS  JSON export is non-empty
PASS  CSV export is non-empty
PASS  the second round (retries=1) finishes
PASS  a cell that only passed on retry carries the ↻ marker
PASS  the ↻ tooltip spells out what the first attempt cost
PASS  the completion banner reports how many combinations needed a retry
PASS  the detail popup shows "attempts" and "first attempt"
PASS  JSON export contains attempts / retried / timingScope
PASS  JSON export no longer contains the misleading totalMs field
PASS  no horizontal overflow at 390px
PASS  no horizontal overflow at 768px
PASS  no horizontal overflow at 1024px
PASS  file:// double-click works (protocol cards and scripts are both there)

====================================================
  32 passed, 0 failed
====================================================
```

> The last 7 are triggered by two combinations in the mock relay that return 500 on every other hit
> (`GET /__reset` clears the counters). In other words the "only passed on retry" path is **actually tested**,
> not just written. Playwright is required: `npm i -D playwright && npx playwright install chromium`.

## Engineering Notes: The Pitfalls

**1. Give a reasoning model too small a `max_tokens` and it returns empty content.**
The first version treated "content is non-empty" as the success criterion, and a whole batch of thinking models got marked as failures.
Switching to "did a valid chunk parse" fixed it.

**2. Vertical table headers were a bad idea.**
With many matrix columns, rotating the protocol names 90° does save width — but Chinese set on a slant is brutally hard to read on screen,
and row height got dragged out to 128px. Going back to horizontal headers that are allowed to wrap brought the header down to 35px.

**3. `white-space: nowrap` blows the grid columns apart.**
The protocol card's path was originally a single-line ellipsis, and on a 390px phone it pushed the grid into a horizontal scrollbar
(`scrollWidth 409 > 390`). The cause: **the max-content width of nowrap text counts toward a grid item's automatic minimum size**,
and adding `min-width: 0` to a flex item only affects shrinking — it doesn't cancel that contribution.
The fix is `grid-template-columns: minmax(0,1fr) auto` on the container, or simply letting the path wrap.

**4. "Select all" ticks the custom protocol too.**
With no URL filled in, hitting start just throws an `alert` and bails —
and in automated tests `alert` is auto-dismissed by default, so it presented as "clicking does nothing". Took a long time to track down.

**5. Some sites return 200 + the homepage HTML for paths that don't exist.**
Look at the status code alone and you'd quietly get an empty list. It now detects the HTML body and reports "returned an HTML page, not an API".

## Limitations

- **The target site must allow cross-origin requests (CORS).** Browser-direct is both the feature and the shackle:
  if the site doesn't send `Access-Control-Allow-Origin`, it simply cannot be tested — that's the browser's rule and there's no way around it.
  It's also why "network/CORS" and "unreachable address" collapse into one state — from the front end they look identical.
- **Only requests a browser can send can be tested.** Some protocols require custom TCP, mTLS or client certificates — not possible here.
- **Latency numbers are affected by your network** and are not the server's real processing time. Inflated numbers when testing across regions are normal.
- **The matrix only reflects the moment you tested.** Upstream channels change, quota runs out, models get added —
  a red cell doesn't mean the model will never work; run a few more rounds before concluding.
- **No scheduled health checks.** Those would mean storing historical results somewhere, and "nothing stored server-side" is a premise of this project.
  If you want trend comparison, accumulate JSON exports yourself.

---

## Disclaimer

This project is a **pure front-end** tool: every request goes from your browser straight to the target address you entered, never through any intermediate server.

To prevent API key leakage, please **do create a fresh, low-quota key** for testing, and **delete it immediately** when you're done;
the author accepts no responsibility for leaked keys, lost quota or any other consequences of using this tool.
