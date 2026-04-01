export const MARKET_HOME_LOAD_LIST_KEYS = [
  'banner',
  'watchlist',
  'spot',
  'perps',
] as const;

export type IMarketHomeLoadListKey =
  (typeof MARKET_HOME_LOAD_LIST_KEYS)[number];

export type IMarketHomeLoadStatus =
  | 'idle'
  | 'loading'
  | 'success'
  | 'empty'
  | 'skipped'
  | 'timeout'
  | 'error';

type ITerminalStatus = Exclude<IMarketHomeLoadStatus, 'idle' | 'loading'>;

type IClockSnapshot = {
  now: number;
  perfNow: number;
};

type ICreateMarketHomeLoadAnalysisSessionParams = {
  route: string;
  selectedNetworkId: string;
  selectedTab: string;
  now?: () => number;
  perfNow?: () => number;
};

type IFinishMarketHomeLoadListParams = {
  status: ITerminalStatus;
  now?: number;
  perfNow?: number;
  itemCount?: number;
  error?: string;
};

type IMarketHomeLoadListRecord = {
  listKey: IMarketHomeLoadListKey;
  status: IMarketHomeLoadStatus;
  startAt?: number;
  endAt?: number;
  durationMs?: number;
  itemCount?: number;
  error?: string;
  startPerfNow?: number;
};

type IMarketHomeLoadReport = {
  summary: {
    sessionId: string;
    createdAt: number;
    route: string;
    selectedNetworkId: string;
    selectedTab: string;
    allSettled: boolean;
  };
  lists: IMarketHomeLoadListRecord[];
};

const TERMINAL_STATUSES = new Set<ITerminalStatus>([
  'success',
  'empty',
  'skipped',
  'timeout',
  'error',
]);

function createClockSnapshot(
  now: () => number,
  perfNow: () => number,
  overrides?: Partial<IClockSnapshot>,
): IClockSnapshot {
  return {
    now: overrides?.now ?? now(),
    perfNow: overrides?.perfNow ?? perfNow(),
  };
}

export function createMarketHomeLoadAnalysisSession({
  route,
  selectedNetworkId,
  selectedTab,
  now = () => Date.now(),
  perfNow = () => performance.now(),
}: ICreateMarketHomeLoadAnalysisSessionParams) {
  const createdAt = now();
  const sessionId = `market-home-${createdAt}`;

  const records = new Map<IMarketHomeLoadListKey, IMarketHomeLoadListRecord>(
    MARKET_HOME_LOAD_LIST_KEYS.map((listKey) => [
      listKey,
      {
        listKey,
        status: 'idle',
      },
    ]),
  );

  const isAllSettled = () =>
    MARKET_HOME_LOAD_LIST_KEYS.every((listKey) =>
      TERMINAL_STATUSES.has(
        (records.get(listKey)?.status ?? 'idle') as ITerminalStatus,
      ),
    );

  const startList = (
    listKey: IMarketHomeLoadListKey,
    overrides?: Partial<IClockSnapshot>,
  ) => {
    const record = records.get(listKey);
    if (!record || record.status !== 'idle') {
      return;
    }

    const snapshot = createClockSnapshot(now, perfNow, overrides);
    records.set(listKey, {
      ...record,
      status: 'loading',
      startAt: snapshot.now,
      startPerfNow: snapshot.perfNow,
    });
  };

  const finishList = (
    listKey: IMarketHomeLoadListKey,
    params: IFinishMarketHomeLoadListParams,
  ) => {
    const record = records.get(listKey);
    if (!record || TERMINAL_STATUSES.has(record.status as ITerminalStatus)) {
      return;
    }

    const snapshot = createClockSnapshot(now, perfNow, {
      now: params.now,
      perfNow: params.perfNow,
    });

    const durationMs =
      typeof record.startPerfNow === 'number'
        ? snapshot.perfNow - record.startPerfNow
        : undefined;

    records.set(listKey, {
      ...record,
      status: params.status,
      endAt: snapshot.now,
      durationMs,
      itemCount: params.itemCount,
      error: params.error,
    });
  };

  const markTimeouts = (overrides?: Partial<IClockSnapshot>) => {
    const snapshot = createClockSnapshot(now, perfNow, overrides);

    MARKET_HOME_LOAD_LIST_KEYS.forEach((listKey) => {
      const record = records.get(listKey);
      if (!record || record.status !== 'loading') {
        return;
      }

      finishList(listKey, {
        status: 'timeout',
        now: snapshot.now,
        perfNow: snapshot.perfNow,
      });
    });
  };

  const buildReport = (): IMarketHomeLoadReport => ({
    summary: {
      sessionId,
      createdAt,
      route,
      selectedNetworkId,
      selectedTab,
      allSettled: isAllSettled(),
    },
    lists: MARKET_HOME_LOAD_LIST_KEYS.map(
      (listKey) => records.get(listKey) as IMarketHomeLoadListRecord,
    ),
  });

  return {
    sessionId,
    startList,
    finishList,
    markTimeouts,
    isAllSettled,
    buildReport,
  };
}
