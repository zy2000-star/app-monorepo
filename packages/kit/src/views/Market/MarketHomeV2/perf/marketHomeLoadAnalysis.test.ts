import { createMarketHomeLoadAnalysisSession } from './marketHomeLoadAnalysis';

describe('createMarketHomeLoadAnalysisSession', () => {
  test('records the first terminal result only once', () => {
    const session = createMarketHomeLoadAnalysisSession({
      route: 'MarketHomeV2',
      selectedNetworkId: 'onekeyall',
      selectedTab: 'trending',
      now: () => 1000,
      perfNow: () => 10,
    });

    session.startList('spot');

    session.finishList('spot', {
      status: 'success',
      itemCount: 20,
      now: 1300,
      perfNow: 13.5,
    });

    session.finishList('spot', {
      status: 'error',
      error: 'late error',
      now: 1400,
      perfNow: 14,
    });

    expect(session.buildReport().lists.find((item) => item.listKey === 'spot'))
      .toMatchObject({
        listKey: 'spot',
        status: 'success',
        itemCount: 20,
        durationMs: 3.5,
      });
  });

  test('marks unfinished lists as timeout when requested', () => {
    const session = createMarketHomeLoadAnalysisSession({
      route: 'MarketHomeV2',
      selectedNetworkId: 'onekeyall',
      selectedTab: 'trending',
      now: () => 2000,
      perfNow: () => 20,
    });

    session.startList('banner');
    session.startList('spot');

    session.finishList('banner', {
      status: 'empty',
      now: 2200,
      perfNow: 22,
    });

    session.markTimeouts({
      now: 12000,
      perfNow: 32,
    });

    expect(session.buildReport()).toMatchObject({
      summary: {
        allSettled: false,
        route: 'MarketHomeV2',
        selectedNetworkId: 'onekeyall',
        selectedTab: 'trending',
      },
    });

    expect(session.buildReport().lists).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          listKey: 'banner',
          status: 'empty',
          durationMs: 2,
        }),
        expect.objectContaining({
          listKey: 'spot',
          status: 'timeout',
          durationMs: 12,
        }),
      ]),
    );
  });
});
