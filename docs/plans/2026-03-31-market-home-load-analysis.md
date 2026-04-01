# Market Home Load Analysis Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Desktop-only runtime analyzer that measures first-load latency for market home lists and writes one JSON report to the Desktop.

**Architecture:** Add a page-scoped collector under `MarketHomeV2`, wire each list hook to report first-load lifecycle events, and introduce one narrow Desktop API method that writes a JSON file to the Desktop. Keep the entire feature behind a Desktop dev/debug guard so it remains side-effect-safe while we validate the workflow.

**Tech Stack:** React, TypeScript, Jotai-adjacent page state, Electron desktop bridge, Node `fs/promises`, existing `desktopApiProxy.dev` plumbing, Jest/Vitest-style unit tests used in the repo.

---

### Task 1: Add collector types and pure aggregation logic

**Files:**
- Create: `packages/kit/src/views/Market/MarketHomeV2/perf/marketHomeLoadAnalysis.ts`
- Create: `packages/kit/src/views/Market/MarketHomeV2/perf/marketHomeLoadAnalysis.test.ts`

**Step 1: Write the failing test**

Add tests that cover:

- starting and settling one list records `durationMs`
- settling the same list twice keeps the first terminal result
- `allSettled` becomes `true` only after all four list keys settle
- global timeout settles unfinished lists as `timeout`
- `buildReport()` returns `summary` and ordered `lists`

Example test cases:

```ts
it('records the first terminal result only once', () => {
  const session = createMarketHomeLoadSession({
    selectedNetworkId: 'onekeyall',
    selectedTab: 'trending',
  });

  session.startList('spot');
  session.finishList('spot', { status: 'success', itemCount: 20 });
  session.finishList('spot', { status: 'error', error: 'late error' });

  expect(session.buildReport().lists.find((i) => i.listKey === 'spot'))
    .toMatchObject({ status: 'success', itemCount: 20 });
});
```

**Step 2: Run test to verify it fails**

Run: `yarn test packages/kit/src/views/Market/MarketHomeV2/perf/marketHomeLoadAnalysis.test.ts --runInBand`

Expected: FAIL because the collector module does not exist yet.

**Step 3: Write minimal implementation**

Implement:

- list key/type definitions for `banner`, `watchlist`, `spot`, `perps`
- a pure in-memory session object
- `startList`
- `finishList`
- `markTimeouts`
- `isAllSettled`
- `buildReport`

Use `Date.now()` for persisted timestamps and `performance.now()` or a provided clock for duration math when available.

**Step 4: Run test to verify it passes**

Run: `yarn test packages/kit/src/views/Market/MarketHomeV2/perf/marketHomeLoadAnalysis.test.ts --runInBand`

Expected: PASS

**Step 5: Commit**

```bash
git add packages/kit/src/views/Market/MarketHomeV2/perf/marketHomeLoadAnalysis.ts packages/kit/src/views/Market/MarketHomeV2/perf/marketHomeLoadAnalysis.test.ts
git commit -m "test: add market home load analysis collector"
```

### Task 2: Add a page-level hook that owns one analysis session

**Files:**
- Create: `packages/kit/src/views/Market/MarketHomeV2/perf/useMarketHomeLoadAnalysis.ts`
- Modify: `packages/kit/src/views/Market/MarketHomeV2/MarketHomeV2.tsx`
- Test: `packages/kit/src/views/Market/MarketHomeV2/perf/marketHomeLoadAnalysis.test.ts`

**Step 1: Write the failing test**

Extend tests for:

- creating a session from `selectedNetworkId` and selected tab
- finalizing once when all lists settle
- invoking a writer callback once with the built report
- marking unfinished lists as `timeout` on session timeout

**Step 2: Run test to verify it fails**

Run: `yarn test packages/kit/src/views/Market/MarketHomeV2/perf/marketHomeLoadAnalysis.test.ts --runInBand`

Expected: FAIL because the page hook and finalize behavior do not exist.

**Step 3: Write minimal implementation**

Create a hook that:

- creates exactly one session per page mount
- exposes stable callbacks to `startList` and `finishList`
- finalizes only once
- triggers a writer callback with the final report
- applies a page-wide timeout such as `12000ms`

Then mount the hook from `MarketHomeV2` and pass session metadata:

- selected network
- selected tab
- route name

**Step 4: Run test to verify it passes**

Run: `yarn test packages/kit/src/views/Market/MarketHomeV2/perf/marketHomeLoadAnalysis.test.ts --runInBand`

Expected: PASS

**Step 5: Commit**

```bash
git add packages/kit/src/views/Market/MarketHomeV2/perf/useMarketHomeLoadAnalysis.ts packages/kit/src/views/Market/MarketHomeV2/MarketHomeV2.tsx packages/kit/src/views/Market/MarketHomeV2/perf/marketHomeLoadAnalysis.test.ts
git commit -m "feat: add market home load analysis session hook"
```

### Task 3: Add Desktop-only report writer bridge

**Files:**
- Modify: `packages/kit-bg/src/desktopApis/DesktopApiDev.ts`
- Modify: `packages/kit-bg/src/desktopApis/instance/IDesktopApi.ts`
- Modify: `packages/shared/types/desktop.ts`
- Create: `packages/kit/src/views/Market/MarketHomeV2/perf/writeMarketHomeLoadReport.desktop.ts`
- Create: `packages/kit/src/views/Market/MarketHomeV2/perf/writeMarketHomeLoadReport.ts`

**Step 1: Write the failing test**

If there is an existing Desktop API test pattern, add a focused test for:

- creating a Desktop file name
- writing JSON content to Desktop
- returning the final file path

If there is no existing test harness for this Desktop API slice, document manual verification in the task and add unit coverage for the renderer-side file-name builder instead.

**Step 2: Run test to verify it fails**

Run the closest available targeted test command for Desktop API tests, or skip to renderer utility tests if no Desktop API test harness exists.

Expected: FAIL or missing method before implementation.

**Step 3: Write minimal implementation**

Add a new `desktopApiProxy.dev` method with a narrow signature like:

```ts
writeMarketHomeLoadReport(params: {
  fileName: string;
  content: string;
}): Promise<{ filePath: string }>
```

Implementation requirements:

- resolve the Desktop path via the existing Electron/Node environment
- create the destination path safely
- write UTF-8 JSON text
- return the written file path

Renderer requirements:

- no-op on non-Desktop platforms
- generate the `market-home-load-report-YYYY-MM-DD_HH-mm-ss.json` file name
- serialize the final report with stable indentation

**Step 4: Run test to verify it passes**

Run the targeted test command used in Step 2, plus any renderer utility tests you add.

Expected: PASS

**Step 5: Commit**

```bash
git add packages/kit-bg/src/desktopApis/DesktopApiDev.ts packages/kit-bg/src/desktopApis/instance/IDesktopApi.ts packages/shared/types/desktop.ts packages/kit/src/views/Market/MarketHomeV2/perf/writeMarketHomeLoadReport.desktop.ts packages/kit/src/views/Market/MarketHomeV2/perf/writeMarketHomeLoadReport.ts
git commit -m "feat: add desktop writer for market load reports"
```

### Task 4: Wire banner and spot list timing

**Files:**
- Modify: `packages/kit/src/views/Market/MarketHomeV2/components/MarketBanner/useMarketBannerList.ts`
- Modify: `packages/kit/src/views/Market/MarketHomeV2/components/MarketTokenList/hooks/useMarketTokenList.ts`
- Modify: `packages/kit/src/views/Market/MarketHomeV2/perf/useMarketHomeLoadAnalysis.ts`
- Test: `packages/kit/src/views/Market/MarketHomeV2/perf/marketHomeLoadAnalysis.test.ts`

**Step 1: Write the failing test**

Add tests or small hook-level assertions that:

- `banner` starts on first request and settles on first resolved result
- `spot` starts on first page request and settles after transformed data commits
- empty results settle as `empty`

**Step 2: Run test to verify it fails**

Run: `yarn test packages/kit/src/views/Market/MarketHomeV2/perf/marketHomeLoadAnalysis.test.ts --runInBand`

Expected: FAIL because hook wiring does not report states yet.

**Step 3: Write minimal implementation**

Expose the analysis callbacks through a local context or hook-local registration utility, then:

- call `startList('banner')` before the first banner request
- call `finishList('banner', ...)` after first result resolves
- call `startList('spot')` before the first spot request
- call `finishList('spot', ...)` after transformed page-1 state is committed

Make sure polling, refresh, and load-more do not create extra sessions or overwrite the first result.

**Step 4: Run test to verify it passes**

Run: `yarn test packages/kit/src/views/Market/MarketHomeV2/perf/marketHomeLoadAnalysis.test.ts --runInBand`

Expected: PASS

**Step 5: Commit**

```bash
git add packages/kit/src/views/Market/MarketHomeV2/components/MarketBanner/useMarketBannerList.ts packages/kit/src/views/Market/MarketHomeV2/components/MarketTokenList/hooks/useMarketTokenList.ts packages/kit/src/views/Market/MarketHomeV2/perf/useMarketHomeLoadAnalysis.ts packages/kit/src/views/Market/MarketHomeV2/perf/marketHomeLoadAnalysis.test.ts
git commit -m "feat: measure banner and spot load timing"
```

### Task 5: Wire watchlist and perps timing

**Files:**
- Modify: `packages/kit/src/views/Market/MarketHomeV2/components/MarketTokenList/hooks/useMarketWatchlistTokenList.ts`
- Modify: `packages/kit/src/views/Market/MarketHomeV2/components/MarketPerpsList/hooks/useMarketPerpsTokenList.ts`
- Modify: `packages/kit/src/views/Market/MarketHomeV2/perf/useMarketHomeLoadAnalysis.ts`
- Test: `packages/kit/src/views/Market/MarketHomeV2/perf/marketHomeLoadAnalysis.test.ts`

**Step 1: Write the failing test**

Add tests that verify:

- `watchlist` settles when merged display data is first available
- `perps` settles when mapped tokens are first available
- empty and error branches map to terminal statuses

**Step 2: Run test to verify it fails**

Run: `yarn test packages/kit/src/views/Market/MarketHomeV2/perf/marketHomeLoadAnalysis.test.ts --runInBand`

Expected: FAIL before hook wiring is added.

**Step 3: Write minimal implementation**

Add first-load reporting to both hooks while ensuring:

- watchlist settles only once despite mixed spot/perps sources
- perps polling does not overwrite first completion
- terminal states are stable

**Step 4: Run test to verify it passes**

Run: `yarn test packages/kit/src/views/Market/MarketHomeV2/perf/marketHomeLoadAnalysis.test.ts --runInBand`

Expected: PASS

**Step 5: Commit**

```bash
git add packages/kit/src/views/Market/MarketHomeV2/components/MarketTokenList/hooks/useMarketWatchlistTokenList.ts packages/kit/src/views/Market/MarketHomeV2/components/MarketPerpsList/hooks/useMarketPerpsTokenList.ts packages/kit/src/views/Market/MarketHomeV2/perf/useMarketHomeLoadAnalysis.ts packages/kit/src/views/Market/MarketHomeV2/perf/marketHomeLoadAnalysis.test.ts
git commit -m "feat: measure watchlist and perps load timing"
```

### Task 6: Finalize guardrails, logging, and Desktop verification

**Files:**
- Modify: `packages/kit/src/views/Market/MarketHomeV2/perf/useMarketHomeLoadAnalysis.ts`
- Modify: `packages/kit/src/views/Market/MarketHomeV2/perf/writeMarketHomeLoadReport.desktop.ts`
- Modify: `packages/kit/src/views/Market/MarketHomeV2/MarketHomeV2.tsx`

**Step 1: Write the failing test**

Add final tests for:

- Desktop-only guard
- development/debug-only guard
- writer failures do not throw into the page
- final report is written once when all lists settle

**Step 2: Run test to verify it fails**

Run the same targeted market analysis test command.

Expected: FAIL before guard behavior is complete.

**Step 3: Write minimal implementation**

Complete the last-mile behavior:

- add a feature guard for Desktop debug/dev usage
- log write failures locally
- ensure finalization is idempotent
- ensure session cleanup on unmount

**Step 4: Run test to verify it passes**

Run: `yarn test packages/kit/src/views/Market/MarketHomeV2/perf/marketHomeLoadAnalysis.test.ts --runInBand`

Expected: PASS

**Step 5: Commit**

```bash
git add packages/kit/src/views/Market/MarketHomeV2/perf/useMarketHomeLoadAnalysis.ts packages/kit/src/views/Market/MarketHomeV2/perf/writeMarketHomeLoadReport.desktop.ts packages/kit/src/views/Market/MarketHomeV2/MarketHomeV2.tsx
git commit -m "feat: finalize market home load analysis reporting"
```

### Task 7: Verify end-to-end behavior

**Files:**
- Modify if needed: implementation files touched above

**Step 1: Run targeted tests**

Run:

```bash
yarn test packages/kit/src/views/Market/MarketHomeV2/perf/marketHomeLoadAnalysis.test.ts --runInBand
```

Expected: PASS

**Step 2: Run type-aware validation for touched files**

Run the smallest available repo validation command that covers the touched files. If no narrow command exists, use the relevant package test/lint command from repo conventions.

Expected: PASS

**Step 3: Manual Desktop verification**

1. Start the Desktop dev build.
2. Enable the debug/dev guard if needed.
3. Open `MarketHomeV2`.
4. Confirm one JSON file appears on the Desktop.
5. Confirm the file contains `banner`, `watchlist`, `spot`, and `perps`.

**Step 4: Fix any issues found and rerun**

Repeat the exact commands above until they pass.

**Step 5: Commit**

```bash
git add <final touched files>
git commit -m "test: verify market home load analysis flow"
```
