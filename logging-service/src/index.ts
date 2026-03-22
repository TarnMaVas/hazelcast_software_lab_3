import Fastify from "fastify";
import { Client, type IMap } from "hazelcast-client";

interface TransactionMsg {
  user_Id: string;
  amount: number;
}

interface TransactionBody extends TransactionMsg {
  transaction_ID: string;
  timestamp: string;
}

interface LogEntry {
  transaction_ID: string;
  timestamp: string;
  msg: TransactionMsg;
}

const app = Fastify({ logger: true });

const PORT = Number(process.env.PORT ?? "3001");
const INSTANCE_NAME = process.env.INSTANCE_NAME ?? "logging-service";
const HZ_CLUSTER_NAME = process.env.HZ_CLUSTER_NAME ?? "assignment-3";
const HZ_MEMBERS = (process.env.HZ_MEMBERS ??
  "hazelcast-1:5701,hazelcast-2:5701,hazelcast-3:5701")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value.length > 0);
const MAP_NAME = "transaction-logs";

let logMap: IMap<string, LogEntry> | null = null;

async function connectToHazelcast(): Promise<IMap<string, LogEntry>> {
  const maxAttempts = 20;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const client = await Client.newHazelcastClient({
        clusterName: HZ_CLUSTER_NAME,
        network: {
          clusterMembers: HZ_MEMBERS,
        },
      });

      const map = await client.getMap<string, LogEntry>(MAP_NAME);
      app.log.info(
        { instanceName: INSTANCE_NAME, members: HZ_MEMBERS, attempt },
        "Connected to Hazelcast cluster",
      );
      return map;
    } catch (error) {
      app.log.warn(
        { err: error, instanceName: INSTANCE_NAME, attempt },
        "Hazelcast connection attempt failed",
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  throw new Error("Unable to connect to Hazelcast cluster");
}

async function getLogMap(): Promise<IMap<string, LogEntry>> {
  if (logMap === null) {
    logMap = await connectToHazelcast();
  }

  return logMap;
}

function sortByTimestamp(entries: LogEntry[]): LogEntry[] {
  return [...entries].sort((left, right) =>
    left.timestamp.localeCompare(right.timestamp),
  );
}

app.post<{ Body: TransactionBody }>("/transaction", async (req) => {
  const { user_Id, amount, transaction_ID, timestamp } = req.body;
  const map = await getLogMap();
  const logEntry: LogEntry = {
    transaction_ID,
    timestamp,
    msg: { user_Id, amount },
  };

  await map.set(transaction_ID, logEntry);

  app.log.info(
    { instanceName: INSTANCE_NAME, transaction_ID, user_Id, amount },
    "Stored transaction in Hazelcast",
  );

  return { ok: true };
});

app.get<{
  Params: { user_Id: string };
  Reply: Array<LogEntry>;
}>("/transaction/:user_Id", async (req) => {
  const { user_Id } = req.params;
  const map = await getLogMap();
  const allLogs = Array.from(await map.values());
  const userLogs = sortByTimestamp(
    allLogs.filter((entry) => entry.msg.user_Id === user_Id),
  );

  app.log.info(
    { instanceName: INSTANCE_NAME, user_Id, count: userLogs.length },
    "Returning user transactions",
  );

  return userLogs;
});

app.get<{
  Reply: {
    transactions: Array<LogEntry>;
  };
}>("/transactions", async () => {
  const map = await getLogMap();
  const transactions = sortByTimestamp(Array.from(await map.values()));

  app.log.info(
    { instanceName: INSTANCE_NAME, count: transactions.length },
    "Returning all transactions",
  );

  return { transactions };
});

app.post("/reset", async () => {
  const map = await getLogMap();
  await map.clear();
  app.log.info({ instanceName: INSTANCE_NAME }, "Cleared transaction map");
  return { ok: true };
});

async function start() {
  try {
    await getLogMap();
    await app.listen({ port: PORT, host: "0.0.0.0" });
    app.log.info(
      { instanceName: INSTANCE_NAME, port: PORT },
      "Logging service is running",
    );
  } catch (error) {
    app.log.error(
      { err: error, instanceName: INSTANCE_NAME },
      "Failed to start logging service",
    );
    process.exit(1);
  }
}

start();
