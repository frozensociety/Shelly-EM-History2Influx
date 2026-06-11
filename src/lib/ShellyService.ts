/**
 * @fileoverview Service layer for interacting with Shelly EM devices.
 * @docs https://shelly-api-docs.shelly.cloud/gen2/ComponentsAndServices/EMData/#emdatagetdata-example
 */

import debug from 'debug';
import type { PointInput } from './InfluxService';
import { logger } from '../lib/Logger';
import ShellyAuthService, { type ShellyAuthObject } from './ShellyAuthService';
import HttpError from './errors';

const d = debug('s2i:ShellyService');

// Helper function to format timestamps
const formatDate = (timestamp: number) => new Date(timestamp * 1000).toISOString();

export type ShellyConfig = {
  host: string;
  username?: string;
  password?: string;
  tags: Record<string, string>;
  measurement?: string;
  historyFetchingDelayInMs?: number; // delay not to overwhelm device
};

export type EMDataResponse = {
  keys?: string[];
  data: {
    ts: number;
    period: number;
    values: number[][];
  }[];
  next_record_ts?: number;
};

export type EMHistory = {
  timestamp: number;
  [key: string]: number;
}[];

const defaultHeaders: Record<string, string> = {
  Accept: 'application/json',
};

/**
 * Service for interacting with Shelly EM devices
 */
export class ShellyService {
  protected readonly baseUrl: string;
  protected readonly authHeader?: string;
  protected readonly config: ShellyConfig;
  public readonly authService: ShellyAuthService;
  protected readonly shutdownSignal?: AbortSignal;

  constructor(
    config: ShellyConfig,
    authService: ShellyAuthService,
    shutdownSignal?: AbortSignal
  ) {
    this.baseUrl = `http://${config.host}`;
    this.config = config;
    this.shutdownSignal = shutdownSignal;
    this.authService = authService;
    logger.info(
      `${config.username}:${config.password}`
    );
    // TODO: check when to use this authentication method.
    // if (config.username && config.password) {
    //   const auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');
    //   this.authHeader = `Basic ${auth}`;
    // }
    d('initialized for host %s', this.baseUrl);
  }

  /**
   * Fetch history data for a given time range using EMData.GetData RPC
   * @param fromTimestamp - Start timestamp in seconds
   * @param toTimestamp - End timestamp in seconds (optional)
   */
  async getHistory(fromTimestamp: number, toTimestamp?: number): Promise<EMHistory> {
    d(
      'fetching history from=%s to=%s',
      formatDate(fromTimestamp),
      toTimestamp ? formatDate(toTimestamp) : 'now'
    );
    let response = await this.fetchHistory(fromTimestamp, toTimestamp);
    const history = this.convertEMData(response);
    while (response.next_record_ts && response.next_record_ts > 0) {
      if (toTimestamp && response.next_record_ts > toTimestamp) {
        break;
      }
      // Small delay to avoid overwhelming the Shelly device
      await new Promise((r) => setTimeout(r, 500));
      d('fetching next page from ts=%s', formatDate(response.next_record_ts));
      response = await this.fetchHistory(response.next_record_ts, toTimestamp);
      history.push(...this.convertEMData(response));
    }
    d('fetched %d records', history.length);
    return history;
  }

  /**
   * Fetch history data page by page using an async generator.
   * Each yielded value is one page of data from the Shelly API,
   * allowing the caller to persist data incrementally.
   */
  async *getHistoryPaged(
    fromTimestamp: number,
    toTimestamp?: number,
  ): AsyncGenerator<EMHistory> {
    d(
      'fetching history paged from=%s to=%s',
      formatDate(fromTimestamp),
      toTimestamp ? formatDate(toTimestamp) : 'now'
    );
    let response = await this.fetchHistory(fromTimestamp, toTimestamp);
    const firstPage = this.convertEMData(response);
    if (firstPage.length > 0) yield firstPage;

    while (response.next_record_ts && response.next_record_ts > 0) {
      if (toTimestamp && response.next_record_ts > toTimestamp) {
        break;
      }
      // Small delay to avoid overwhelming the Shelly device
      await new Promise((r) => setTimeout(r, this.config.historyFetchingDelayInMs ?? 500));
      d('fetching next page from ts=%s', formatDate(response.next_record_ts));
      response = await this.fetchHistory(response.next_record_ts, toTimestamp);
      const page = this.convertEMData(response);
      if (page.length > 0) yield page;
    }
  }

  /**
   * Convert EMDataResponse to EMHistory format
   */
  protected convertEMData(response: EMDataResponse): EMHistory {
    const { keys = [], data } = response;
    const historyItems: EMHistory = [];

    data.forEach(({ ts, period, values }) => {
      values.forEach((dataSet, index) => {
        // Calculate timestamp for this history-item
        const historyItem: EMHistory[number] = {
          timestamp: ts + index * period,
        };

        // Map values to their corresponding keys
        keys.forEach((key, valueIndex) => {
          historyItem[key] = dataSet[valueIndex];
        });

        // Calculate totals for each phase
        if (
          typeof historyItem.a_total_act_energy === 'number' &&
          typeof historyItem.b_total_act_energy === 'number' &&
          typeof historyItem.c_total_act_energy === 'number'
        ) {
          historyItem.total_act_energy =
            historyItem.a_total_act_energy +
            historyItem.b_total_act_energy +
            historyItem.c_total_act_energy;
        }
        if (
          typeof historyItem.a_total_act_ret_energy === 'number' &&
          typeof historyItem.b_total_act_ret_energy === 'number' &&
          typeof historyItem.c_total_act_ret_energy === 'number'
        ) {
          historyItem.total_act_ret_energy =
            historyItem.a_total_act_ret_energy +
            historyItem.b_total_act_ret_energy +
            historyItem.c_total_act_ret_energy;
        }

        historyItems.push(historyItem);
      });
    });

    return historyItems;
  }

  /**
   * Get the measurement name configured for this Shelly device
   */
  public getMeasurementName(): string {
    return this.config.measurement ?? 'shelly_em';
  }

  /**
   * Get the host name
   */
  public getHost(): string {
    return this.config.host;
  }

  /**
   * Get the device name
   */
  public getDeviceName(): string {
    return this.config.tags.device_name;
  }

  /**
   * Convert EMHistory items to InfluxDB points
   */
  public toInfluxPoints(history: EMHistory): PointInput[] {
    return history.map(({ timestamp, ...fields }) => ({
      measurement: this.getMeasurementName(),
      fields,
      timestamp,
      tags: this.config.tags,
    }));
  }

  /**
   * Create an AbortSignal combining a per-request timeout with the shutdown signal
   */
  protected createAbortSignal(timeoutMs: number): AbortSignal {
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
    if (this.shutdownSignal) {
      signals.push(this.shutdownSignal);
    }
    return AbortSignal.any(signals);
  }



  /**
   * Fetch raw history data from the Shelly device
   * @param fromTimestamp - Start timestamp in seconds
   * @param toTimestamp - End timestamp in seconds (optional)
   */
  protected async fetchHistory(
    fromTimestamp: number,
    toTimestamp?: number,
  ): Promise<EMDataResponse> {
    const url = `${this.baseUrl}/rpc`;
    d('fetching data from: %s', url);

    const authObject = await this.authService.getAuthObject();
    const payload = this.createRequestBody(fromTimestamp, toTimestamp, authObject);

    const response = await fetch(url, {
      // verbose: true,
      method: 'POST',
      headers: defaultHeaders,
      signal: this.createAbortSignal(30_000),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new HttpError(
        `Failed to fetch history: ${response.status} ${response.statusText
        }\n${await response.text()}`,
        response.status,
      );
    }

    return await this.parseHistoryResult(response);
  }


  private createRequestBody(fromTimestamp: number, toTimestamp: number | undefined, authObject: ShellyAuthObject) {
    return {
      params: {
        id: 0,
        ts: fromTimestamp.toString(),
        ...(toTimestamp && { end_ts: toTimestamp.toString() }),
      },
      id: 15,
      auth: authObject,
      method: "EMData.GetData",
    };
  }

  private async parseHistoryResult(response: Response) {
    const json = (await response.json()) as Record<string, unknown>;
    const result = json.result as Record<string, unknown> | undefined;
    // console.log(result)
    if (!result || !Array.isArray(result?.data)) {
      throw new Error('Unexpected response from Shelly API: missing "data" array');
    }
    return result as unknown as EMDataResponse;
  }

  async testConnectionToShellyDevice(): Promise<void> {
    d('testing connection to %s', this.baseUrl);
    const headers: Record<string, string> = {};
    // TODO: Fix auth and , not working anymore with newer device/firmware
    if (this.authHeader) {
      headers.Authorization = this.authHeader;
    }

    const response = await fetch(`${this.baseUrl}/rpc/Shelly.GetStatus`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: 1,
        method: 'Shelly.GetStatus',
      }),
      signal: this.createAbortSignal(10_000),
    });

    if (!response.ok) {
      throw new Error(`Connection test failed: ${response.status} ${response.statusText}`);
    }
    d('connection test result passed');
  }
}
