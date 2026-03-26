import { backgroundMethod } from '@onekeyhq/shared/src/background/backgroundDecorators';
import { OneKeyLocalError } from '@onekeyhq/shared/src/errors';
import {
  EAppEventBusNames,
  appEventBus,
} from '@onekeyhq/shared/src/eventBus/appEventBus';
import { EAppSocketEventNames } from '@onekeyhq/shared/types/socket';

import { writeSpotMarketRealtimeDiagnostic } from '../../diagnostics/spotMarketRealtimeDiagnostics';
import ServiceBase from '../ServiceBase';

import { EChannel, EOperation } from './const';
import { MarketSubscriptionTracker } from './MarketSubscriptionTracker';
import { EMessageType } from './types/messageType';
import {
  convertOkxPriceDataToWsPriceData,
  isOkxPriceData,
} from './types/okxPriceData';
import { convertOkxTxsDataToWsTxsData, isOkxTxsData } from './types/okxTxsData';

import type { ISubscriptionType } from './MarketSubscriptionTracker';
import type { IWsPriceData, IWsTxsData } from './types';
import type { Socket } from 'socket.io-client';

type IMarketSubscription = {
  channel: string;
  networkId: string;
  tokenAddress: string;
  chartType?: string;
  currencyCode?: string;
  dataSource?: string;
};

type IMarketMessage = {
  operation: string;
  args: IMarketSubscription[];
};

class ServiceMarketWS extends ServiceBase {
  constructor({ backgroundApi }: { backgroundApi: any }) {
    super({ backgroundApi });
  }

  private socket: Socket | null = null;

  private isMarketListenerRegistered = false;

  private isReconnectListenerRegistered = false;

  private retryTimers: ReturnType<typeof setTimeout>[] = [];

  private marketWatchdogTimer: ReturnType<typeof setInterval> | null = null;

  private lastMarketMessageAt = 0;

  private lastMessageAtByChannel: Partial<Record<ISubscriptionType, number>> =
    {};

  private lastRawTokenTxsMessageAt = 0;

  private messageCountByChannel: Partial<Record<ISubscriptionType, number>> =
    {};

  private rawTokenTxsMessageCount = 0;

  private unmatchedTokenTxsMessageCount = 0;

  private reconnectHandler = () => {
    this.logDiagnostic('market_ws_socket_connect', {
      socketId: this.socket?.id,
    });
    this.resubscribeAll();
  };

  private marketHandler = (data: unknown) => {
    console.log('handleMarketMessage', data);
    this.handleMarketMessage(data);
  };

  subscriptionTracker: MarketSubscriptionTracker =
    new MarketSubscriptionTracker();

  @backgroundMethod()
  async clearDataCount(params: { address: string; type: ISubscriptionType }) {
    this.subscriptionTracker.clearDataCount(params);
  }

  @backgroundMethod()
  async connect(): Promise<void> {
    // Get the shared WebSocket from PushProviderWebSocket
    const webSocketProvider = (
      await this.backgroundApi.serviceNotification.getNotificationProvider()
    )?.webSocketProvider;

    if (!webSocketProvider) {
      throw new OneKeyLocalError('WebSocket provider not available');
    }

    this.socket = webSocketProvider.getSocket();

    if (!this.socket) {
      throw new OneKeyLocalError('WebSocket connection not available');
    }

    this.ensureMarketWatchdog();

    // Register market data listener only once
    if (!this.isMarketListenerRegistered) {
      this.socket.on(EAppSocketEventNames.market, this.marketHandler);
      this.isMarketListenerRegistered = true;
    }

    // Re-subscribe all active subscriptions after reconnect
    if (!this.isReconnectListenerRegistered) {
      this.socket.on('connect', this.reconnectHandler);
      this.isReconnectListenerRegistered = true;
    }

    this.logDiagnostic(
      'market_ws_connect',
      {
        socketId: this.socket.id,
        connected: this.socket.connected,
        marketListenerRegistered: this.isMarketListenerRegistered,
        reconnectListenerRegistered: this.isReconnectListenerRegistered,
      },
      {
        throttleKey: 'market-ws:connect',
        throttleMs: 5000,
      },
    );

    return Promise.resolve();
  }

  @backgroundMethod()
  async ensureSubscription({
    networkId,
    tokenAddress,
    chartType,
    currency,
    channel,
  }: {
    networkId: string;
    tokenAddress: string;
    chartType?: string;
    currency?: string;
    channel: string;
  }) {
    if (!this.socket) {
      return;
    }

    const hasExisting = this.subscriptionTracker.hasSubscription({
      address: tokenAddress,
      type: channel as ISubscriptionType,
    });

    if (hasExisting) {
      // Subscription still exists in tracker — just re-emit to server and reset data count
      const subscriptionArgs: IMarketSubscription = {
        channel,
        networkId,
        tokenAddress,
        chartType,
        currencyCode: currency,
        dataSource: 'okx',
      };
      const message: IMarketMessage = {
        operation: EOperation.subscribe,
        args: [subscriptionArgs],
      };
      this.emitSubscribeWithRetry({ message });
      this.subscriptionTracker.clearDataCount({
        address: tokenAddress,
        type: channel as ISubscriptionType,
      });
      this.logDiagnostic('market_ws_ensure_subscription_reemit', {
        channel,
        tokenAddress,
        networkId,
        chartType,
        currency,
      });
    } else if (channel === EChannel.ohlcv) {
      // Subscription was auto-unsubscribed — re-create it
      this.logDiagnostic('market_ws_ensure_subscription_recreate', {
        channel,
        tokenAddress,
        networkId,
        chartType,
        currency,
      });
      await this.subscribeOHLCV({
        networkId,
        tokenAddress,
        chartType,
        currency,
      });
    } else if (channel === EChannel.tokenTxs) {
      await this.subscribeTokenTxs({
        networkId,
        tokenAddress,
        currency,
      });
    }
  }

  private resubscribeAll() {
    // Cancel all pending retry timers to prevent duplicate subscriptions
    this.clearRetryTimers();

    const subscriptions = this.subscriptionTracker.getSubscriptions();
    if (subscriptions.length === 0) {
      return;
    }
    console.log(
      `Reconnected, re-subscribing ${subscriptions.length} active subscription(s)`,
    );
    this.logDiagnostic('market_ws_resubscribe_all', {
      count: subscriptions.length,
      subscriptions: this.getSubscriptionSnapshot(),
    });
    for (const sub of subscriptions) {
      const subscriptionArgs: IMarketSubscription = {
        channel: sub.type,
        networkId: sub.networkId,
        tokenAddress: sub.address,
        chartType: sub.chartType,
        currencyCode: sub.currency,
        dataSource: 'okx',
      };
      const message: IMarketMessage = {
        operation: EOperation.subscribe,
        args: [subscriptionArgs],
      };
      this.socket?.emit(EAppSocketEventNames.market, message);
      // Reset data count on re-subscribe to prevent stale threshold triggers
      this.subscriptionTracker.clearDataCount({
        address: sub.address,
        type: sub.type,
      });
    }
  }

  private emitSubscribeWithRetry({
    message,
    retries = 3,
    delayMs = 2000,
  }: {
    message: IMarketMessage;
    retries?: number;
    delayMs?: number;
  }) {
    if (this.socket?.connected) {
      this.socket.emit(EAppSocketEventNames.market, message);
      this.logDiagnostic('market_ws_subscribe_emit', {
        message,
        socketId: this.socket.id,
      });
      return;
    }
    if (retries <= 0) {
      console.error('WebSocket not connected after retries, subscribe failed');
      this.logDiagnostic('market_ws_subscribe_failed_not_connected', {
        message,
      });
      return;
    }
    this.logDiagnostic(
      'market_ws_subscribe_retry_scheduled',
      {
        message,
        retriesRemaining: retries,
        delayMs,
        socketConnected: this.socket?.connected ?? false,
      },
      {
        throttleKey: `market-ws:subscribe-retry:${JSON.stringify(message.args)}`,
        throttleMs: delayMs,
      },
    );
    const timer = setTimeout(() => {
      this.retryTimers = this.retryTimers.filter((t) => t !== timer);
      this.emitSubscribeWithRetry({
        message,
        retries: retries - 1,
        delayMs,
      });
    }, delayMs);
    this.retryTimers.push(timer);
  }

  private clearRetryTimers() {
    this.retryTimers.forEach(clearTimeout);
    this.retryTimers = [];
  }

  @backgroundMethod()
  async disconnect() {
    // Cancel all pending retry timers
    this.clearRetryTimers();

    // Remove market data listener (pass specific handler to avoid removing others)
    if (this.socket && this.isMarketListenerRegistered) {
      this.socket.off(EAppSocketEventNames.market, this.marketHandler);
      this.isMarketListenerRegistered = false;
    }

    if (this.socket && this.isReconnectListenerRegistered) {
      this.socket.off('connect', this.reconnectHandler);
      this.isReconnectListenerRegistered = false;
    }

    const subscriptions = this.getSubscriptionSnapshot();

    this.socket = null;
    this.clearMarketWatchdog();
    this.subscriptionTracker.clear();
    this.lastMarketMessageAt = 0;
    this.lastMessageAtByChannel = {};
    this.lastRawTokenTxsMessageAt = 0;
    this.messageCountByChannel = {};
    this.rawTokenTxsMessageCount = 0;
    this.unmatchedTokenTxsMessageCount = 0;
    this.logDiagnostic('market_ws_disconnect', {
      subscriptions,
    });
  }

  @backgroundMethod()
  async subscribeTokenTxs({
    networkId,
    tokenAddress,
    currency = 'usd',
  }: {
    networkId: string;
    tokenAddress: string;
    currency?: string;
  }) {
    // Check if already subscribed
    if (
      this.subscriptionTracker.hasSubscription({
        address: tokenAddress,
        type: EChannel.tokenTxs,
      })
    ) {
      this.subscriptionTracker.addSubscription({
        address: tokenAddress,
        type: EChannel.tokenTxs,
        networkId,
        currency,
      });
      this.logDiagnostic('market_ws_subscribe_token_txs_duplicate', {
        tokenAddress,
        networkId,
        currency,
      });
      return;
    }

    const subscriptionArgs: IMarketSubscription = {
      channel: EChannel.tokenTxs,
      networkId,
      tokenAddress,
      currencyCode: currency,
      dataSource: 'okx',
    };

    const message: IMarketMessage = {
      operation: EOperation.subscribe,
      args: [subscriptionArgs],
    };

    this.emitSubscribeWithRetry({ message });
    this.subscriptionTracker.addSubscription({
      address: tokenAddress,
      type: EChannel.tokenTxs,
      networkId,
      currency,
    });
    this.logDiagnostic('market_ws_subscribe_token_txs', {
      tokenAddress,
      networkId,
      currency,
    });
  }

  @backgroundMethod()
  async subscribeOHLCV({
    networkId,
    tokenAddress,
    chartType = '1m',
    currency = 'usd',
  }: {
    networkId: string;
    tokenAddress: string;
    chartType?: string;
    currency?: string;
  }) {
    // Check if already subscribed
    if (
      this.subscriptionTracker.hasSubscription({
        address: tokenAddress,
        type: EChannel.ohlcv,
      })
    ) {
      this.subscriptionTracker.addSubscription({
        address: tokenAddress,
        type: EChannel.ohlcv,
        networkId,
        chartType,
        currency,
      });
      this.logDiagnostic('market_ws_subscribe_ohlcv_duplicate', {
        tokenAddress,
        networkId,
        chartType,
        currency,
      });
      return;
    }

    const subscriptionArgs: IMarketSubscription = {
      channel: EChannel.ohlcv,
      networkId,
      tokenAddress,
      chartType,
      currencyCode: currency,
      dataSource: 'okx',
    };

    const message: IMarketMessage = {
      operation: EOperation.subscribe,
      args: [subscriptionArgs],
    };

    this.emitSubscribeWithRetry({ message });
    this.subscriptionTracker.addSubscription({
      address: tokenAddress,
      type: EChannel.ohlcv,
      networkId,
      chartType,
      currency,
    });
    this.logDiagnostic('market_ws_subscribe_ohlcv', {
      tokenAddress,
      networkId,
      chartType,
      currency,
    });
  }

  private async unsubscribe({
    channel,
    networkId,
    tokenAddress,
    chartType,
    currency,
  }: {
    channel: string;
    networkId: string;
    tokenAddress: string;
    chartType?: string;
    currency?: string;
  }) {
    const subscriptionArgs: IMarketSubscription = {
      channel,
      networkId,
      tokenAddress,
      chartType,
      currencyCode: currency,
      dataSource: 'okx',
    };

    const message: IMarketMessage = {
      operation: EOperation.unsubscribe,
      args: [subscriptionArgs],
    };

    if (!this.socket?.connected) {
      this.logDiagnostic('market_ws_unsubscribe_skipped_socket_disconnected', {
        channel,
        tokenAddress,
        networkId,
        chartType,
        currency,
      });
      return;
    }

    this.socket.emit(EAppSocketEventNames.market, message);
    this.logDiagnostic('market_ws_unsubscribe_emit', {
      channel,
      tokenAddress,
      networkId,
      chartType,
      currency,
    });
  }

  @backgroundMethod()
  async unsubscribeTokenTxs({
    networkId,
    tokenAddress,
    currency = 'usd',
  }: {
    networkId: string;
    tokenAddress: string;
    currency?: string;
  }) {
    this.subscriptionTracker.removeSubscription({
      address: tokenAddress,
      type: EChannel.tokenTxs,
      networkId,
      currency,
    });

    // Only unsubscribe from WebSocket if no more connections
    if (
      !this.subscriptionTracker.hasSubscription({
        address: tokenAddress,
        type: EChannel.tokenTxs,
      })
    ) {
      this.logDiagnostic('market_ws_unsubscribe_token_txs', {
        tokenAddress,
        networkId,
        currency,
      });
      await this.unsubscribe({
        channel: EChannel.tokenTxs,
        networkId,
        tokenAddress,
        currency,
      });
    }
  }

  @backgroundMethod()
  async unsubscribeOHLCV({
    networkId,
    tokenAddress,
    chartType = '1m',
    currency = 'usd',
  }: {
    networkId: string;
    tokenAddress: string;
    chartType?: string;
    currency?: string;
  }) {
    this.subscriptionTracker.removeSubscription({
      address: tokenAddress,
      type: EChannel.ohlcv,
      networkId,
      chartType,
      currency,
    });

    // Only unsubscribe from WebSocket if no more connections
    if (
      !this.subscriptionTracker.hasSubscription({
        address: tokenAddress,
        type: EChannel.ohlcv,
      })
    ) {
      this.logDiagnostic('market_ws_unsubscribe_ohlcv', {
        tokenAddress,
        networkId,
        chartType,
        currency,
      });
      await this.unsubscribe({
        channel: EChannel.ohlcv,
        networkId,
        tokenAddress,
        chartType,
        currency,
      });
    }
  }

  private handleMarketMessage(data: unknown) {
    // Basic type validation
    if (typeof data !== 'object' || data === null) {
      return;
    }

    const messageData = data as Record<string, any>;

    // Handle different message formats from the WebSocket
    // Support both direct channel format and nested data format
    let channel: ISubscriptionType;
    let tokenAddress = '';
    let messageType: string | undefined;
    let processedData: any;

    console.log('messageData', messageData);

    if ('type' in messageData && 'data' in messageData) {
      messageType = messageData.type as string;
      const rawData = messageData.data as Record<string, any>;

      if (messageType === EMessageType.TXS_DATA && Array.isArray(rawData)) {
        const normalizedItem = rawData.find((item) => isOkxTxsData(item));
        if (!normalizedItem) {
          return;
        }

        processedData = convertOkxTxsDataToWsTxsData(normalizedItem);
      } else if (
        messageType === EMessageType.TXS_DATA &&
        isOkxTxsData(rawData)
      ) {
        processedData = convertOkxTxsDataToWsTxsData(rawData);
      } else if (
        messageType === EMessageType.PRICE_DATA &&
        Array.isArray(rawData)
      ) {
        const normalizedItem = rawData.find((item) => isOkxPriceData(item));
        if (!normalizedItem) {
          return;
        }

        processedData = convertOkxPriceDataToWsPriceData(normalizedItem);
      } else if (
        messageType === EMessageType.PRICE_DATA &&
        isOkxPriceData(rawData)
      ) {
        processedData = convertOkxPriceDataToWsPriceData(rawData);
      } else {
        processedData = rawData;
      }
    } else {
      return;
    }

    if (messageType === EMessageType.TXS_DATA) {
      channel = EChannel.tokenTxs;
      const txsData = processedData as IWsTxsData;

      // Check both from and to addresses for TXS_DATA
      const fromAddress = txsData.from?.address;
      const toAddress = txsData.to?.address;
      this.recordRawTokenTxsMessage(txsData);

      // Try to find which address has subscription and increment its data count
      let hasSubscription = false;
      let matchedBy: 'from' | 'to' | undefined;
      if (
        fromAddress &&
        this.subscriptionTracker.hasSubscription({
          address: fromAddress,
          type: EChannel.tokenTxs,
        })
      ) {
        this.subscriptionTracker.incrementDataCount({
          address: fromAddress,
          type: EChannel.tokenTxs,
        });
        tokenAddress = fromAddress;
        hasSubscription = true;
        matchedBy = 'from';
      } else if (
        toAddress &&
        this.subscriptionTracker.hasSubscription({
          address: toAddress,
          type: EChannel.tokenTxs,
        })
      ) {
        this.subscriptionTracker.incrementDataCount({
          address: toAddress,
          type: EChannel.tokenTxs,
        });
        tokenAddress = toAddress;
        hasSubscription = true;
        matchedBy = 'to';
      }

      // If no subscription found, skip this message
      if (!hasSubscription) {
        this.unmatchedTokenTxsMessageCount += 1;
        this.logDiagnostic(
          'market_ws_token_txs_unmatched',
          {
            txHash: txsData.txHash,
            owner: txsData.owner,
            poolId: txsData.poolId,
            fromAddress,
            toAddress,
            subscribedTokenTxsAddresses:
              this.getTokenTxsSubscriptionAddresses(),
            rawTokenTxsMessageCount: this.rawTokenTxsMessageCount,
            unmatchedTokenTxsMessageCount: this.unmatchedTokenTxsMessageCount,
          },
          {
            throttleKey: `market-ws:token-txs-unmatched:${
              fromAddress ?? 'unknown'
            }:${toAddress ?? 'unknown'}`,
            throttleMs: 15_000,
          },
        );
        return;
      }

      this.logDiagnostic(
        'market_ws_token_txs_matched',
        {
          tokenAddress,
          matchedBy,
          txHash: txsData.txHash,
          owner: txsData.owner,
          poolId: txsData.poolId,
          fromAddress,
          toAddress,
          rawTokenTxsMessageCount: this.rawTokenTxsMessageCount,
          unmatchedTokenTxsMessageCount: this.unmatchedTokenTxsMessageCount,
        },
        {
          throttleKey: `market-ws:token-txs-matched:${tokenAddress}`,
          throttleMs: 15_000,
        },
      );
    } else if (messageType === EMessageType.PRICE_DATA) {
      channel = EChannel.ohlcv;
      const priceData = processedData as IWsPriceData;
      tokenAddress = priceData.address;

      // Increment data count for PRICE_DATA
      if (
        this.subscriptionTracker.hasSubscription({
          address: tokenAddress,
          type: EChannel.ohlcv,
        })
      ) {
        this.subscriptionTracker.incrementDataCount({
          address: tokenAddress,
          type: EChannel.ohlcv,
        });
      } else {
        // If no subscription found, skip this message
        return;
      }
    } else {
      console.warn('Invalid market data: missing required fields', {
        tokenAddress,
        originalData: data,
      });
      this.logDiagnostic(
        'market_ws_invalid_payload',
        {
          originalData: data,
        },
        {
          throttleKey: 'market-ws:invalid-payload',
          throttleMs: 15_000,
        },
      );

      return;
    }

    this.recordMarketMessage({
      channel,
      tokenAddress,
      messageType,
    });

    const shouldAutoUnsubscribe =
      channel === EChannel.ohlcv
        ? this.subscriptionTracker.shouldUnsubscribeOhlcvByDefaultInactivity({
            address: tokenAddress,
          })
        : this.subscriptionTracker.shouldUnsubscribeWithDefaultThreshold({
            address: tokenAddress,
            type: channel,
          });

    // For OHLCV, inactivity is a better signal than raw message volume because
    // the UI intentionally throttles realtime rendering.
    if (shouldAutoUnsubscribe) {
      const subscription = this.subscriptionTracker.getSubscription({
        address: tokenAddress,
        type: channel,
      });
      if (subscription) {
        console.warn(
          channel === EChannel.ohlcv
            ? `Auto-unsubscribing due to OHLCV inactivity: ${tokenAddress}, channel: ${channel}, lastConsumedAt: ${subscription.lastConsumedAt}`
            : `Auto-unsubscribing due to data accumulation: ${tokenAddress}, channel: ${channel}, dataCount: ${subscription.dataCount}`,
        );
        this.logDiagnostic('market_ws_auto_unsubscribe', {
          channel,
          tokenAddress,
          networkId: subscription.networkId,
          chartType: subscription.chartType,
          currency: subscription.currency,
          dataCount: subscription.dataCount,
          lastConsumedAt: subscription.lastConsumedAt,
        });

        // Auto-unsubscribe based on channel type
        if (channel === EChannel.tokenTxs) {
          void this.unsubscribeTokenTxs({
            networkId: subscription.networkId,
            tokenAddress: subscription.address,
            currency: subscription.currency,
          });
        } else if (channel === EChannel.ohlcv) {
          void this.unsubscribeOHLCV({
            networkId: subscription.networkId,
            tokenAddress: subscription.address,
            chartType: subscription.chartType,
            currency: subscription.currency,
          });
        }
      }
    }

    // Emit event to app event bus with standardized format
    appEventBus.emit(EAppEventBusNames.MarketWSDataUpdate, {
      channel,
      tokenAddress,
      messageType,
      data: processedData,
      originalData: data,
    });
  }

  private logDiagnostic(
    event: string,
    payload: Record<string, unknown> = {},
    options?: {
      throttleKey?: string;
      throttleMs?: number;
    },
  ) {
    writeSpotMarketRealtimeDiagnostic({
      event,
      payload: {
        ...payload,
        socketConnected: this.socket?.connected ?? false,
      },
      throttleKey: options?.throttleKey,
      throttleMs: options?.throttleMs,
    });
  }

  private getSubscriptionSnapshot() {
    const subscriptions = this.subscriptionTracker.getSubscriptions();
    return {
      total: subscriptions.length,
      byChannel: {
        ohlcv: subscriptions.filter((sub) => sub.type === EChannel.ohlcv)
          .length,
        tokenTxs: subscriptions.filter((sub) => sub.type === EChannel.tokenTxs)
          .length,
      },
      sample: subscriptions.slice(0, 5).map((sub) => ({
        address: sub.address,
        type: sub.type,
        networkId: sub.networkId,
        chartType: sub.chartType,
        currency: sub.currency,
        connectionCount: sub.connectionCount,
        dataCount: sub.dataCount,
        lastConsumedAt: sub.lastConsumedAt,
      })),
    };
  }

  private getTokenTxsSubscriptionAddresses() {
    return this.subscriptionTracker
      .getSubscriptionsByType(EChannel.tokenTxs)
      .map((sub) => sub.address);
  }

  private ensureMarketWatchdog() {
    if (this.marketWatchdogTimer) {
      return;
    }

    this.marketWatchdogTimer = setInterval(() => {
      const subscriptions = this.subscriptionTracker.getSubscriptions();
      if (subscriptions.length === 0) {
        return;
      }

      const now = Date.now();
      const lastMarketMessageAgeMs = this.lastMarketMessageAt
        ? now - this.lastMarketMessageAt
        : null;

      if (!this.socket?.connected) {
        this.logDiagnostic(
          'market_ws_watchdog_socket_disconnected',
          {
            lastMarketMessageAgeMs,
            subscriptions: this.getSubscriptionSnapshot(),
          },
          {
            throttleKey: 'market-ws:watchdog-socket-disconnected',
            throttleMs: 15_000,
          },
        );
        return;
      }

      if (
        !this.lastMarketMessageAt ||
        (lastMarketMessageAgeMs ?? 0) >= 20_000
      ) {
        this.logDiagnostic(
          'market_ws_watchdog_no_market_messages',
          {
            lastMarketMessageAgeMs,
            lastMessageAgeByChannelMs: Object.fromEntries(
              Object.entries(this.lastMessageAtByChannel).map(
                ([channel, timestamp]) => [
                  channel,
                  timestamp ? now - timestamp : null,
                ],
              ),
            ),
            messageCountByChannel: this.messageCountByChannel,
            subscriptions: this.getSubscriptionSnapshot(),
          },
          {
            throttleKey: 'market-ws:watchdog-no-market-messages',
            throttleMs: 15_000,
          },
        );
      }

      const tokenTxsSubscriptions =
        this.subscriptionTracker.getSubscriptionsByType(EChannel.tokenTxs);
      const lastMatchedTokenTxsAt =
        this.lastMessageAtByChannel[EChannel.tokenTxs] ?? 0;
      const lastMatchedTokenTxsAgeMs = lastMatchedTokenTxsAt
        ? now - lastMatchedTokenTxsAt
        : null;
      const lastRawTokenTxsAgeMs = this.lastRawTokenTxsMessageAt
        ? now - this.lastRawTokenTxsMessageAt
        : null;

      if (
        tokenTxsSubscriptions.length > 0 &&
        (lastMarketMessageAgeMs ?? Number.MAX_SAFE_INTEGER) < 30_000 &&
        (!this.lastRawTokenTxsMessageAt || lastRawTokenTxsAgeMs === null)
      ) {
        this.logDiagnostic(
          'market_ws_watchdog_token_txs_no_raw_messages',
          {
            lastMarketMessageAgeMs,
            rawTokenTxsMessageCount: this.rawTokenTxsMessageCount,
            unmatchedTokenTxsMessageCount: this.unmatchedTokenTxsMessageCount,
            tokenTxsSubscriptions: tokenTxsSubscriptions.map((sub) => ({
              address: sub.address,
              networkId: sub.networkId,
              currency: sub.currency,
            })),
          },
          {
            throttleKey: 'market-ws:watchdog-token-txs-no-raw',
            throttleMs: 30_000,
          },
        );
      }

      if (
        tokenTxsSubscriptions.length > 0 &&
        lastRawTokenTxsAgeMs !== null &&
        lastRawTokenTxsAgeMs < 30_000 &&
        (lastMatchedTokenTxsAgeMs === null ||
          lastMatchedTokenTxsAgeMs >= 30_000)
      ) {
        this.logDiagnostic(
          'market_ws_watchdog_token_txs_unmatched_flow',
          {
            lastMarketMessageAgeMs,
            lastRawTokenTxsAgeMs,
            lastMatchedTokenTxsAgeMs,
            rawTokenTxsMessageCount: this.rawTokenTxsMessageCount,
            unmatchedTokenTxsMessageCount: this.unmatchedTokenTxsMessageCount,
            subscribedTokenTxsAddresses:
              this.getTokenTxsSubscriptionAddresses(),
          },
          {
            throttleKey: 'market-ws:watchdog-token-txs-unmatched-flow',
            throttleMs: 30_000,
          },
        );
      }
    }, 10_000);
  }

  private clearMarketWatchdog() {
    if (!this.marketWatchdogTimer) {
      return;
    }

    clearInterval(this.marketWatchdogTimer);
    this.marketWatchdogTimer = null;
  }

  private recordMarketMessage({
    channel,
    tokenAddress,
    messageType,
  }: {
    channel: ISubscriptionType;
    tokenAddress: string;
    messageType?: string;
  }) {
    const now = Date.now();
    const previousAnyMessageAt = this.lastMarketMessageAt;
    const previousChannelMessageAt = this.lastMessageAtByChannel[channel] ?? 0;

    this.lastMarketMessageAt = now;
    this.lastMessageAtByChannel[channel] = now;
    this.messageCountByChannel[channel] =
      (this.messageCountByChannel[channel] ?? 0) + 1;

    this.logDiagnostic(
      'market_ws_message_summary',
      {
        channel,
        tokenAddress,
        messageType,
        totalMessagesForChannel: this.messageCountByChannel[channel],
        gapSincePreviousAnyMessageMs: previousAnyMessageAt
          ? now - previousAnyMessageAt
          : null,
        gapSincePreviousChannelMessageMs: previousChannelMessageAt
          ? now - previousChannelMessageAt
          : null,
        dataCount: this.subscriptionTracker.getDataCount({
          address: tokenAddress,
          type: channel,
        }),
      },
      {
        throttleKey: `market-ws:message-summary:${channel}`,
        throttleMs: 15_000,
      },
    );
  }

  private recordRawTokenTxsMessage(txsData: IWsTxsData) {
    const now = Date.now();
    const previousRawTokenTxsAt = this.lastRawTokenTxsMessageAt;

    this.lastRawTokenTxsMessageAt = now;
    this.rawTokenTxsMessageCount += 1;

    this.logDiagnostic(
      'market_ws_token_txs_raw_message',
      {
        txHash: txsData.txHash,
        owner: txsData.owner,
        poolId: txsData.poolId,
        fromAddress: txsData.from?.address,
        toAddress: txsData.to?.address,
        rawTokenTxsMessageCount: this.rawTokenTxsMessageCount,
        gapSincePreviousRawTokenTxsMs: previousRawTokenTxsAt
          ? now - previousRawTokenTxsAt
          : null,
      },
      {
        throttleKey: 'market-ws:token-txs-raw-message',
        throttleMs: 15_000,
      },
    );
  }
}

export default ServiceMarketWS;
