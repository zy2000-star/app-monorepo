# Market Home Load Analysis Design

**Date:** 2026-03-31

**Goal:** Automatically analyze first-load latency for each list on `MarketHomeV2` and write one local report file to the Desktop on desktop builds.

## Scope

This work targets the market home page entry at `packages/kit/src/views/Market/MarketHomeV2`.

The analysis covers four list groups:

- `banner`
- `watchlist`
- `spot`
- `perps`

The first version only writes a Desktop-local file. It does not add remote analytics reporting and does not attempt to write files on mobile, web, or extension platforms.

## Requirements

When the user enters `MarketHomeV2`, the app should:

1. Start a page-level analysis session.
2. Measure first-load timing for each list group.
3. Aggregate the results into one report.
4. Write exactly one report file to the local Desktop.
5. Never block or degrade the normal market page experience if analysis fails.

## Existing Context

`MarketHomeV2` already has separate loading hooks for each data source:

- `useMarketBannerList`
- `useMarketTokenList`
- `useMarketWatchlistTokenList`
- `useMarketPerpsTokenList`

There is also an existing market analytics pattern using `defaultLogger.dex.list.*`, but the current requirement is local file output rather than server-side analytics. Desktop already exposes development-oriented file export behavior through `desktopApiProxy.dev`, so the new Desktop write path should follow that bridge pattern instead of introducing a UI download flow.

## Chosen Approach

Use a lightweight page-scoped runtime collector that records timing marks from each list hook and writes a single JSON report through a new desktop API method.

This approach is preferred because it directly solves the requested behavior:

- timing is captured close to the list data lifecycle
- output is structured for later machine analysis
- local file writing is explicit and controllable
- failure stays isolated from the user-facing page

## Alternative Approaches Considered

### Option A: Server analytics only

Record timings using `defaultLogger.dex.list.*` and inspect them in the analytics backend.

Why not chosen:

- does not satisfy local Desktop file output
- adds analysis friction for ad-hoc inspection

### Option B: Runtime collector plus local Desktop file

Record first-load timings in-page and write a JSON file to Desktop automatically.

Why chosen:

- directly matches the requirement
- minimal dependency on external tooling
- best fit for local performance inspection

### Option C: Dual-write to analytics plus local file

Record timings to both analytics and Desktop output.

Why deferred:

- adds maintenance and event-definition overhead
- not required for the first delivery

## Architecture

### 1. Page session collector

Create a page-level collector owned by `MarketHomeV2` that:

- creates a `sessionId`
- stores `createdAt`, route, platform, selected tab, and selected network
- tracks one entry per list key
- settles each list exactly once
- emits one final report when all lists are settled or a global timeout is reached

### 2. Hook-level timing reporters

Each existing list hook reports state transitions to the collector:

- `start`
- `success`
- `empty`
- `error`
- `skipped`
- `timeout`

Each hook owns the timing boundary closest to its own "first usable data" point.

### 3. Desktop report writer

Add one narrow desktop bridge method to write a JSON payload to the Desktop with a deterministic file name:

`market-home-load-report-YYYY-MM-DD_HH-mm-ss.json`

The renderer should call this only after aggregation is complete.

## Timing Semantics

The first version measures **first-load usable data latency** only.

It does not include:

- polling refreshes
- manual refresh
- pagination or `loadMore`
- later tab revisits in the same session

### List completion rules

#### `banner`

- start: first request execution inside `useMarketBannerList`
- end: first resolved state where `bannerList !== undefined`
- empty responses still count as settled

#### `spot`

- start: first page request inside `useMarketTokenList`
- end: after page-1 data has been transformed and committed into local state
- pagination is excluded

#### `watchlist`

- start: first watchlist data fetch path begins
- end: after the merged watchlist result becomes first available for display
- includes both spot and perps dependencies needed by watchlist

#### `perps`

- start: first request inside `useMarketPerpsTokenList`
- end: after token mapping completes for the first usable result

## Status Model

Each list record uses one of:

- `idle`
- `loading`
- `success`
- `empty`
- `skipped`
- `timeout`
- `error`

Rules:

- once a list reaches a terminal state, later updates are ignored
- a list may be `skipped` if the page session never initializes that source
- a page-wide timeout ensures the final file is still written

## Report Format

The output format is JSON and contains:

- `summary`
- `lists`

Example shape:

```json
{
  "summary": {
    "sessionId": "market-home-1711860000000",
    "createdAt": "2026-03-31T10:23:45.000+08:00",
    "platform": "desktop",
    "route": "MarketHomeV2",
    "selectedTab": "trending",
    "selectedNetworkId": "onekeyall",
    "allSettled": true
  },
  "lists": [
    {
      "listKey": "spot",
      "status": "success",
      "startAt": 1711860000000,
      "endAt": 1711860001320,
      "durationMs": 1320,
      "itemCount": 20,
      "extra": {
        "networkId": "onekeyall",
        "category": "trending",
        "timeRange": "24h"
      }
    }
  ]
}
```

## Error Handling

This feature must be fully side-effect-safe:

- list measurement failures must not break the market page
- Desktop write failures must not break the market page
- errors should be logged locally for debugging

The collector should tolerate partial failure and still write a final report when possible.

## Platform Strategy

Only Desktop builds write to the Desktop filesystem in v1.

Other platforms:

- do not write a file
- may keep the collector disabled or no-op

This keeps the first delivery narrow and avoids cross-platform file behavior differences.

## Rollout Strategy

The first delivery should be guarded behind a development/debug-facing switch so we can validate the experience before broader rollout. This avoids uncontrolled file generation on users' desktops.

Recommended initial guard:

- desktop only
- development or explicit debug flag only

## Testing Strategy

Test the feature at three levels:

1. Collector unit tests
2. Hook timing boundary tests
3. Desktop file writer verification

Critical scenarios:

- normal success
- empty result
- skipped result
- error result
- timeout result
- final report written exactly once
- page unmount before settle

## Success Criteria

The implementation is successful when:

1. Entering market home on Desktop produces one report file on the Desktop.
2. The file contains settled timing data for `banner`, `watchlist`, `spot`, and `perps`.
3. Timing collection does not interrupt normal page behavior.
4. A failed list or failed write does not break the page.
