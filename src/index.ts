import debug from 'debug';
import { getConfig } from './config';
import ShellyAuthService from './lib/ShellyAuthService';
import { createInfluxService } from './lib/InfluxService';
import { logger } from './lib/Logger';
import { ShellyService } from './lib/ShellyService';
import HttpError from './lib/errors';
import { match } from 'ts-pattern';

// Debug namespace
const d = debug('s2i');

// Icons for console output
const icons = {
  error: '❌',
  info: 'ℹ️',
  warning: '⚠️',
  success: '✅',
} as const;

/** Maximum backoff interval in seconds (15 minutes) */
const MAX_BACKOFF_SECONDS = 900;


logger.info(
  `🚀 Shelly EM History 2 Influx ${process.env.SHELLY_EM_HISTORY2INFLUX_VERSION || 'development-version'}`
);

const config = getConfig();

// Abort controller for cancelling in-flight requests on shutdown
const shutdownController = new AbortController();

// Global state for cleanup
const services: { influx: ReturnType<typeof createInfluxService>; shelly: ShellyService[] } = {
  influx: createInfluxService(config.influx),
  shelly: config.shelly.map((cfg) => new ShellyService(
    cfg,
    new ShellyAuthService(cfg),
    shutdownController.signal,
  )
  ),
};

// Track active timeouts for cleanup
const activeTimeouts: Set<ReturnType<typeof setTimeout>> = new Set();

enum ScrapeResult {
  success,
  failure,
  authenticationErrorResolved,
  authenticationErrorUnresolved,
}

/**
 * Scrape data from a single Shelly device and write to InfluxDB page by page.
 * Each API page is written immediately so progress is preserved on abort.
 * Returns true on success, false on failure.
 */
async function scrapeDevice(shelly: ShellyService): Promise<ScrapeResult> {
  const measurement = shelly.getMeasurementName();

  let lastTimestamp = 0;
  try {
    lastTimestamp = await fetchLastTimestampFromInflux(lastTimestamp, measurement, shelly);
  } catch (error) {
    logger.error(`${icons.error} Error getting last timestamp from InfluxDB: ${error}`);
    return ScrapeResult.failure;
  }

  const date = new Date(lastTimestamp * 1000).toISOString();
  logger.info(`fetching history since ${date} for device ${shelly.getDeviceName()}`);

  let totalPoints = 0;
  try {
    for await (const page of shelly.getHistoryPaged(lastTimestamp)) {
      const points = shelly.toInfluxPoints(page);
      d(
        'writing %d points to influx for device %s (measurement: %s)',
        points.length,
        shelly.getDeviceName(),
        measurement
      );
      await services.influx.bulkWrite(points);
      totalPoints += points.length;
      logger.info(
        `${icons.success} Wrote ${points.length} points from ${shelly.getDeviceName()} to ${measurement} from ${new Date(page[0].timestamp * 1000).toISOString()} to ${new Date(
          page[page.length - 1].timestamp * 1000
        ).toISOString()}`
      );
    }
  } catch (error) {
    if (error instanceof HttpError) {
      reAuthenticateAfterError(shelly);
      return ScrapeResult.authenticationErrorResolved;
    } else {

      logger.error(
        `${icons.error} Error during scrape for ${shelly.getDeviceName()}: ${error}`
      );
      return ScrapeResult.failure;
    }
  }

  if (totalPoints === 0) {
    d('no new data for device %s', shelly.getDeviceName());
    logger.warn(`${icons.warning} No new history-data from device ${shelly.getDeviceName()}`);
  }

  return ScrapeResult.success;
}

async function reAuthenticateAfterError(shelly: ShellyService) {
  logger.error(`❌ Authentication error for ${shelly.getDeviceName()}: Unauthorized 401`);
  logger.info(`Performing authentication`);

  for (let attempts = 1; attempts <= 3; attempts++) {
    try {
      shelly.authService.reset();
      await shelly.authService.getAuthObject();
      await shelly.authService.testAuthWorks();
      break;
    } catch (error) {
      attempts++
      await new Promise((r) => setTimeout(r, 5000 * attempts));
    }
  }
}


async function fetchLastTimestampFromInflux(lastTimestamp: number, measurement: string, shelly: ShellyService) {
  lastTimestamp =
    (await services.influx.getLastTimestamp(measurement, shelly.getDeviceName())) ?? 0;
  // increment time by 1 second because we already scraped data until "lastTimestamp"
  lastTimestamp++;
  d('last timestamp for measurement %s: %d', measurement, lastTimestamp);
  if (lastTimestamp < 10) {
    logger.warn(
      `${icons.warning} Initial scrape for ${shelly.getDeviceName()} - this could take a while...`
    );
  }
  return lastTimestamp;
}

/**
 * Continuous scraping loop for a single device with exponential backoff on failures
 */
async function deviceScrapeLoop(shelly: ShellyService): Promise<never> {
  let consecutiveFailures = 0;

  while (true) {
    let scrapeResult = ScrapeResult.failure;
    try {
      consecutiveFailures++;
      scrapeResult = await scrapeDevice(shelly);
      if (scrapeResult === ScrapeResult.success || scrapeResult === ScrapeResult.authenticationErrorResolved) {
        consecutiveFailures = 0;
      }
    } catch (error) {
      logger.error(`${icons.error} Unexpected error for ${shelly.getDeviceName()}: ${error}`);
    }

    // Exponential backoff: double the interval on each consecutive failure, capped at MAX_BACKOFF_SECONDS
    const waitSeconds = match({ scrapeResult })
      .with({ scrapeResult: ScrapeResult.success }, () => config.scrapeInterval)
      .with({ scrapeResult: ScrapeResult.authenticationErrorResolved }, () => 0)
      .otherwise(() => Math.min(config.scrapeInterval * 2 ** consecutiveFailures, MAX_BACKOFF_SECONDS))

    if (consecutiveFailures > 0) {
      d(
        'device %s: %d consecutive failures, waiting %ds before retry',
        shelly.getDeviceName(),
        consecutiveFailures,
        waitSeconds
      );
    }

    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        activeTimeouts.delete(timeout);
        resolve(undefined);
      }, waitSeconds * 1000);
      activeTimeouts.add(timeout);
    });
  }
}


/**
 * Start independent scraping loops for all devices
 */
function startScraping(): void {
  d('starting scrape loops for %d devices', services.shelly.length);
  for (const shelly of services.shelly) {
    deviceScrapeLoop(shelly).catch((error) => {
      logger.error(`${icons.error} Device ${shelly.getDeviceName()} scrape loop failed: ${error}`);
    });
  }
}

/**
 * Graceful shutdown
 */
async function shutdown(): Promise<void> {
  d('initiating shutdown');
  logger.info(`${icons.info} Shutting down...`);

  // Abort all in-flight fetch requests
  shutdownController.abort();

  // Clear all active timeouts
  for (const timeout of activeTimeouts) {
    clearTimeout(timeout);
  }
  activeTimeouts.clear();

  try {
    await services.influx.close();
    d('successfully closed all connections');
    logger.info(`${icons.success} Successfully closed all connections`);
    process.exit(0);
  } catch (error) {
    logger.error(`${icons.error} Error during shutdown: ${error}`);
    process.exit(1);
  }
}

// Set up signal handlers
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', (reason) => {
  logger.error(`${icons.error} Unhandled rejection: ${reason}`);
});

/**
 * Ensure the InfluxDB connection is working.
 * Retry InfluxDB connection until it succeeds — no point scraping if we can't write
 */
async function testInfluxDbConnection(): Promise<void> {
  while (true) {
    try {
      await services.influx.testConnection();
      logger.info(`${icons.success} InfluxDB connection successful`);
      break;
    } catch (error) {
      logger.error(`${icons.error} InfluxDB: ${(error as Error).message}`);
      logger.info(`${icons.info} Retrying InfluxDB connection in 10 seconds...`);
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          activeTimeouts.delete(timeout);
          resolve(undefined);
        }, 10_000);
        activeTimeouts.add(timeout);
      });
    }
  }
}

async function testShellyConnections(): Promise<void> {
  await Promise.all(
    services.shelly.map(async (shelly, i, services) => {
      await shelly.authService.getAuthObject();
      await shelly.authService.testAuthWorks();
      logger.info(`${icons.success} Connection to Shelly device ${shelly.getDeviceName()} works!`);
    }
    ));
}

async function startApplication(): Promise<void> {
  await testInfluxDbConnection();
  await testShellyConnections();

  logger.info(`${icons.info} Starting scrapers with interval of ${config.scrapeInterval} seconds`);
  startScraping();
}

// Start the application
startApplication();
