import Fastify from "fastify";
import { randomUUID } from "crypto";

interface TransactionMsg {
  user_Id: string;
  amount: number;
}

interface TransactionBody extends TransactionMsg {
  transaction_ID: string;
  timestamp: string;
}

interface TransactionLog {
  transaction_ID: string;
  timestamp: string;
  msg: TransactionMsg;
}

interface Metrics {
  logging: {
    averageMs: number;
    calls: number;
    timeMS: number;
  };
  counter: {
    averageMs: number;
    calls: number;
    timeMS: number;
  };
}

const app = Fastify({ logger: true });

const PORT = Number(process.env.PORT ?? "3000");
const COUNTER_SERVICE_URL =
  process.env.COUNTER_URL ?? "http://counter-service:3002";
const LOGGING_SERVICE_URLS = (
  process.env.LOGGING_URLS ??
  "http://logging-service-1:3001,http://logging-service-2:3001,http://logging-service-3:3001"
)
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value.length > 0);

let loggingTimeMS = 0;
let counterTimeMS = 0;
let loggingCalls = 0;
let counterCalls = 0;

function getLoggingFailoverOrder(): string[] {
  if (LOGGING_SERVICE_URLS.length === 0) {
    throw new Error("No logging service URLs configured");
  }

  const startIndex = Math.floor(Math.random() * LOGGING_SERVICE_URLS.length);
  return LOGGING_SERVICE_URLS.map(
    (_, index) =>
      LOGGING_SERVICE_URLS[(startIndex + index) % LOGGING_SERVICE_URLS.length]!,
  );
}

async function fetchLoggingWithFailover(
  path: string,
  init?: RequestInit,
): Promise<{ ms: number; res: Response; url: string }> {
  const startedAt = performance.now();
  let lastError: unknown;

  for (const baseUrl of getLoggingFailoverOrder()) {
    try {
      const res = await fetch(`${baseUrl}${path}`, init);
      if (!res.ok) {
        const body = await res.text();
        lastError = new Error(
          `Replica ${baseUrl} returned ${res.status}: ${body || res.statusText}`,
        );
        app.log.warn(
          { replica: baseUrl, path, status: res.status },
          "Logging replica request failed",
        );
        continue;
      }

      return {
        ms: performance.now() - startedAt,
        res,
        url: baseUrl,
      };
    } catch (error) {
      lastError = error;
      app.log.warn(
        { err: error, replica: baseUrl, path },
        "Logging replica unavailable",
      );
    }
  }

  throw new Error(
    `All logging replicas failed for ${path}: ${String(lastError)}`,
  );
}

async function timedFetch(
  url: string,
  init?: RequestInit,
): Promise<{ ms: number; res: Response }> {
  const startedAt = performance.now();
  const res = await fetch(url, init);
  return {
    ms: performance.now() - startedAt,
    res,
  };
}

app.post<{ Body: TransactionMsg }>("/transaction", async (req) => {
  const transactionBody: TransactionBody = {
    ...req.body,
    transaction_ID: randomUUID(),
    timestamp: new Date().toISOString(),
  };

  const loggingPromise = (async () => {
    const { ms, res, url } = await fetchLoggingWithFailover("/transaction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(transactionBody),
    });
    loggingTimeMS += ms;
    loggingCalls++;
    app.log.info(
      { transaction_ID: transactionBody.transaction_ID, replica: url },
      "Transaction logged",
    );
    return res;
  })();

  const counterPromise = (async () => {
    const { ms, res } = await timedFetch(`${COUNTER_SERVICE_URL}/transaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(transactionBody),
    });
    counterTimeMS += ms;
    counterCalls++;

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Counter service failed with ${res.status}: ${body || res.statusText}`,
      );
    }

    return (await res.json()) as { balance: number };
  })();

  try {
    const [, counterData] = await Promise.all([loggingPromise, counterPromise]);

    return {
      transaction_ID: transactionBody.transaction_ID,
      balance: counterData.balance,
    };
  } catch (error) {
    app.log.error({ err: error }, "Failed to process transaction");
    throw error;
  }
});

app.get<{
  Params: { user_Id: string };
  Reply: { balance: number | null; logs: Array<TransactionLog> };
}>("/user/:user_Id", async (req) => {
  const { user_Id } = req.params;

  const balancePromise = (async () => {
    const { ms, res } = await timedFetch(
      `${COUNTER_SERVICE_URL}/balance/${encodeURIComponent(user_Id)}`,
    );
    counterTimeMS += ms;
    counterCalls++;

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Counter balance request failed with ${res.status}: ${body || res.statusText}`,
      );
    }

    return (await res.json()) as { balance: number };
  })();

  const logsPromise = (async () => {
    const { ms, res, url } = await fetchLoggingWithFailover(
      `/transaction/${encodeURIComponent(user_Id)}`,
    );
    loggingTimeMS += ms;
    loggingCalls++;
    app.log.info({ user_Id, replica: url }, "Fetched user logs");
    return (await res.json()) as Array<TransactionLog>;
  })();

  try {
    const [balance, logs] = await Promise.all([balancePromise, logsPromise]);
    return { balance: balance.balance, logs };
  } catch (error) {
    app.log.error({ err: error, user_Id }, "Failed to read user data");
    throw error;
  }
});

app.get<{ Reply: { accounts: Record<string, number> } }>(
  "/accounts",
  async () => {
    const { ms, res } = await timedFetch(`${COUNTER_SERVICE_URL}/balances`);
    counterTimeMS += ms;
    counterCalls++;

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Counter balances request failed with ${res.status}: ${body || res.statusText}`,
      );
    }

    const data = (await res.json()) as Record<string, number>;
    return { accounts: data };
  },
);

app.get<{ Reply: Metrics }>("/metrics", async () => ({
  logging: {
    averageMs: loggingCalls > 0 ? loggingTimeMS / loggingCalls : 0,
    calls: loggingCalls,
    timeMS: loggingTimeMS,
  },
  counter: {
    averageMs: counterCalls > 0 ? counterTimeMS / counterCalls : 0,
    calls: counterCalls,
    timeMS: counterTimeMS,
  },
}));

app.post("/metrics/reset", async () => {
  loggingTimeMS = 0;
  counterTimeMS = 0;
  loggingCalls = 0;
  counterCalls = 0;
  return { ok: true };
});

async function start() {
  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });
    app.log.info({ port: PORT }, "Facade service is running");
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

start();
