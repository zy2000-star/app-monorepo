const SPOT_MARKET_REALTIME_DIAGNOSTIC_FILE_NAME =
  'spot-market-realtime-diagnostic.log';

const throttledEventTimestamps = new Map<string, number>();

function serializeDiagnosticValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeDiagnosticValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        serializeDiagnosticValue(item),
      ]),
    );
  }

  return value;
}

export function writeSpotMarketRealtimeDiagnostic({
  event,
  payload,
  throttleKey,
  throttleMs,
}: {
  event: string;
  payload?: Record<string, unknown>;
  throttleKey?: string;
  throttleMs?: number;
}) {
  if (!globalThis.desktopApiProxy?.dev?.appendDiagnosticLineToDesktop) {
    return;
  }

  if (throttleKey && throttleMs && throttleMs > 0) {
    const now = Date.now();
    const lastTimestamp = throttledEventTimestamps.get(throttleKey) ?? 0;
    if (now - lastTimestamp < throttleMs) {
      return;
    }
    throttledEventTimestamps.set(throttleKey, now);
  }

  const serializedPayload = payload
    ? (serializeDiagnosticValue(payload) as Record<string, unknown>)
    : {};

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...serializedPayload,
  });

  void globalThis.desktopApiProxy.dev
    .appendDiagnosticLineToDesktop({
      fileName: SPOT_MARKET_REALTIME_DIAGNOSTIC_FILE_NAME,
      line,
    })
    .catch((error) => {
      console.error('Failed to append spot market realtime diagnostic', error);
    });
}

export { SPOT_MARKET_REALTIME_DIAGNOSTIC_FILE_NAME };
