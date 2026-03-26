# Spot OHLCV Auto-Unsubscribe Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop active spot chart OHLCV subscriptions from being auto-unsubscribed while the page is still consuming realtime updates.

**Architecture:** Keep the existing OHLCV websocket subscription flow, but change the unsubscribe decision from message-count accumulation to consumption inactivity. Reuse the existing frontend consumption callback to mark the subscription as active without increasing WebView update frequency.

**Tech Stack:** TypeScript, Jest, Jotai/background services, socket.io client integration

---

### Task 1: Implement the OHLCV unsubscribe fix

**Files:**
- Modify: `packages/kit-bg/src/services/ServiceMarketWS/ServiceMarektWs.ts`
- Modify: `packages/kit-bg/src/services/ServiceMarketWS/MarketSubscriptionTracker.ts`

**Step 1: Write minimal implementation**

Change OHLCV auto-unsubscribe to use last-consumed inactivity instead of raw message accumulation.

**Step 2: Verify manually**

Run the smallest relevant verification command available for the touched code, or validate with targeted runtime reproduction if automated coverage is intentionally skipped.

**Step 3: Commit**

```bash
git add packages/kit-bg/src/services/ServiceMarketWS/ServiceMarektWs.ts packages/kit-bg/src/services/ServiceMarketWS/MarketSubscriptionTracker.ts
git commit -m "fix: prevent spot ohlcv auto unsubscribe"
```

### Task 2: Wire frontend consumption to the new keepalive semantics

**Files:**
- Modify: `packages/kit/src/components/TradingView/TradingViewV2/hooks/useTradingViewV2WebSocket.ts`

**Step 1: Write minimal implementation**

Keep the existing 4-second UI throttling, but make the frontend callback clearly act as a subscription keepalive for OHLCV consumption.

**Step 2: Verify manually**

Confirm the logic still clears the OHLCV subscription activity state on consumed updates.

**Step 3: Commit**

```bash
git add packages/kit/src/components/TradingView/TradingViewV2/hooks/useTradingViewV2WebSocket.ts
git commit -m "fix: keep active spot ohlcv subscriptions alive"
```

### Task 3: Verify the targeted behavior

**Files:**
- Modify: none unless a test fix is needed

**Step 1: Sanity check git status**

Run: `git status --short`
Expected: only intended files changed

**Step 2: Commit**

```bash
git add packages/kit-bg/src/services/ServiceMarketWS/ServiceMarektWs.ts packages/kit-bg/src/services/ServiceMarketWS/MarketSubscriptionTracker.ts packages/kit/src/components/TradingView/TradingViewV2/hooks/useTradingViewV2WebSocket.ts docs/plans/2026-03-25-spot-ohlcv-auto-unsubscribe.md
git commit -m "fix: prevent spot ohlcv auto unsubscribe"
```
