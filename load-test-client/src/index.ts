interface TransactionRequest {
  user_Id: string;
  amount: number;
}

interface TransactionResponse {
  transaction_ID: string;
  balance: number;
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

interface TransactionLog {
  transaction_ID: string;
  timestamp: string;
  msg: { user_Id: string; amount: number };
}

interface UserInfo {
  balance: number;
  logs: TransactionLog[];
}

interface TestResult {
  scenario: string;
  totalRequests: number;
  totalTimeSeconds: number;
  requestsPerSecond: number;
  successfulRequests: number;
  failedRequests: number;
  metrics: Metrics;
  finalBalances: Record<string, number>;
}

const FACADE_URL = process.env.FACADE_URL ?? "http://localhost:3000";
const COUNTER_URL = process.env.COUNTER_URL ?? "http://localhost:3002";
const LOGGING_URLS = (process.env.LOGGING_URLS ??
  "http://localhost:3001,http://localhost:3003,http://localhost:3004")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value.length > 0);

function getLoggingFailoverOrder(): string[] {
  if (LOGGING_URLS.length === 0) {
    throw new Error("No logging service URLs configured");
  }

  const startIndex = Math.floor(Math.random() * LOGGING_URLS.length);
  return LOGGING_URLS.map(
    (_, index) => LOGGING_URLS[(startIndex + index) % LOGGING_URLS.length]!,
  );
}

async function fetchHealthyLogging(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  let lastError: unknown;

  for (const baseUrl of getLoggingFailoverOrder()) {
    try {
      const res = await fetch(`${baseUrl}${path}`, init);
      if (res.ok) {
        return res;
      }

      const body = await res.text();
      lastError = new Error(
        `Replica ${baseUrl} returned ${res.status}: ${body || res.statusText}`,
      );
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(`All logging replicas failed: ${String(lastError)}`);
}

async function makeTransaction(
  userId: string,
  amount: number,
): Promise<TransactionResponse> {
  const response = await fetch(`${FACADE_URL}/transaction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_Id: userId, amount } as TransactionRequest),
  });

  if (!response.ok) {
    throw new Error(`Transaction failed: ${response.statusText}`);
  }

  return (await response.json()) as TransactionResponse;
}

async function getBalances(): Promise<Record<string, number>> {
  const response = await fetch(`${FACADE_URL}/accounts`);
  if (!response.ok) {
    throw new Error(`Failed to get balances: ${response.statusText}`);
  }

  const data = (await response.json()) as { accounts: Record<string, number> };
  return data.accounts;
}

async function getMetrics(): Promise<Metrics> {
  const response = await fetch(`${FACADE_URL}/metrics`);
  if (!response.ok) {
    throw new Error(`Failed to get metrics: ${response.statusText}`);
  }

  return (await response.json()) as Metrics;
}

async function resetMetrics(): Promise<void> {
  const response = await fetch(`${FACADE_URL}/metrics/reset`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Failed to reset metrics: ${response.statusText}`);
  }
}

async function resetAllData(): Promise<void> {
  const counterResponse = await fetch(`${COUNTER_URL}/reset`, { method: "POST" });
  if (!counterResponse.ok) {
    throw new Error(
      `Failed to reset counter service: ${counterResponse.statusText}`,
    );
  }

  const loggingResponse = await fetchHealthyLogging("/reset", { method: "POST" });
  if (!loggingResponse.ok) {
    throw new Error(
      `Failed to reset logging service: ${loggingResponse.statusText}`,
    );
  }

  console.log("All data reset successfully");
}

async function getUserInfo(userId: string): Promise<UserInfo> {
  const response = await fetch(`${FACADE_URL}/user/${encodeURIComponent(userId)}`);
  if (!response.ok) {
    throw new Error(`Failed to get user info: ${response.statusText}`);
  }

  return (await response.json()) as UserInfo;
}

async function runClient(
  clientId: number,
  userId: string,
  transactionCount: number,
  amount: number,
): Promise<{ successful: number; failed: number }> {
  let successful = 0;
  let failed = 0;

  console.log(
    `Client ${clientId}: Starting ${transactionCount} transactions for user ${userId}`,
  );

  for (let index = 0; index < transactionCount; index++) {
    try {
      await makeTransaction(userId, amount);
      successful++;

      if ((index + 1) % 1000 === 0) {
        console.log(
          `Client ${clientId}: Completed ${index + 1}/${transactionCount} transactions`,
        );
      }
    } catch (error) {
      failed++;
      console.error(
        `Client ${clientId}: Transaction ${index + 1} failed:`,
        error,
      );
    }
  }

  console.log(
    `Client ${clientId}: Finished. Successful: ${successful}, Failed: ${failed}`,
  );

  return { successful, failed };
}

async function runScenario(
  scenario: string,
  numClients: number,
  transactionsPerClient: number,
  getUserId: (clientId: number) => string,
  amount: number,
): Promise<TestResult> {
  console.log("\n" + "-".repeat(100));
  console.log(`SCENARIO: ${scenario}`);
  console.log("-".repeat(80));
  console.log(`Clients: ${numClients}`);
  console.log(`Transactions per client: ${transactionsPerClient}`);
  console.log(`Total transactions: ${numClients * transactionsPerClient}`);
  console.log("-".repeat(80) + "\n");

  await resetAllData();
  await resetMetrics();

  const startTime = performance.now();
  const clientPromises: Array<Promise<{ successful: number; failed: number }>> = [];

  for (let clientIndex = 0; clientIndex < numClients; clientIndex++) {
    clientPromises.push(
      runClient(
        clientIndex + 1,
        getUserId(clientIndex),
        transactionsPerClient,
        amount,
      ),
    );
  }

  const results = await Promise.all(clientPromises);
  const totalTimeSeconds = (performance.now() - startTime) / 1000;

  const successfulRequests = results.reduce((sum, item) => sum + item.successful, 0);
  const failedRequests = results.reduce((sum, item) => sum + item.failed, 0);
  const totalRequests = numClients * transactionsPerClient;
  const requestsPerSecond = successfulRequests / totalTimeSeconds;
  const finalBalances = await getBalances();
  const metrics = await getMetrics();

  console.log("\n" + "-".repeat(80));
  console.log("RESULTS:");
  console.log("-".repeat(80));
  console.log(`Total requests: ${totalRequests}`);
  console.log(`Successful requests: ${successfulRequests}`);
  console.log(`Failed requests: ${failedRequests}`);
  console.log(`Total time: ${totalTimeSeconds.toFixed(2)} seconds`);
  console.log(`Requests per second: ${requestsPerSecond.toFixed(2)} req/s`);
  console.log("\nService timing breakdown:");
  console.log(
    `  Logging service: ${(metrics.logging.timeMS / 1000).toFixed(2)} s (total time for all calls, ${metrics.logging.calls} calls, avg: ${metrics.logging.averageMs.toFixed(2)} ms)`,
  );
  console.log(
    `  Counter service: ${(metrics.counter.timeMS / 1000).toFixed(2)} s (total time for all calls, ${metrics.counter.calls} calls, avg: ${metrics.counter.averageMs.toFixed(2)} ms)`,
  );

  const totalServiceTime = metrics.logging.timeMS + metrics.counter.timeMS;
  if (totalServiceTime > 0) {
    console.log(
      `  Logging contribution: ${((metrics.logging.timeMS / totalServiceTime) * 100).toFixed(2)}%`,
    );
    console.log(
      `  Counter contribution: ${((metrics.counter.timeMS / totalServiceTime) * 100).toFixed(2)}%`,
    );
  }

  console.log("\nFinal balances:");
  for (const [userId, balance] of Object.entries(finalBalances).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    console.log(`  ${userId}: ${balance}`);
  }

  console.log("-".repeat(80) + "\n");

  return {
    scenario,
    totalRequests,
    totalTimeSeconds,
    requestsPerSecond,
    successfulRequests,
    failedRequests,
    metrics,
    finalBalances,
  };
}

async function runFunctionalTest(): Promise<void> {
  console.log("\n" + "-".repeat(80));
  console.log("FUNCTIONAL TEST: Basic System Correctness");
  console.log("-".repeat(80));

  await resetAllData();
  await resetMetrics();

  const tx1 = await makeTransaction("alice", 100);
  const tx2 = await makeTransaction("bob", 50);
  const tx3 = await makeTransaction("alice", 25);
  const tx4 = await makeTransaction("alice", -30);
  const tx5 = await makeTransaction("bob", -10);
  const tx6 = await makeTransaction("charlie", 75);
  const tx7 = await makeTransaction("charlie", -25);

  console.log(
    `  Alice tx: ${tx1.transaction_ID}, ${tx3.transaction_ID}, ${tx4.transaction_ID}`,
  );
  console.log(`  Bob tx: ${tx2.transaction_ID}, ${tx5.transaction_ID}`);
  console.log(`  Charlie tx: ${tx6.transaction_ID}, ${tx7.transaction_ID}`);

  const aliceInfo = await getUserInfo("alice");
  const bobInfo = await getUserInfo("bob");
  const charlieInfo = await getUserInfo("charlie");
  const allBalances = await getBalances();

  const expectedAliceBalance = 95;
  const expectedBobBalance = 40;
  const expectedCharlieBalance = 50;

  console.log(
    `  Alice balance: ${aliceInfo.balance}, logs: ${aliceInfo.logs.length}`,
  );
  console.log(`  Bob balance: ${bobInfo.balance}, logs: ${bobInfo.logs.length}`);
  console.log(
    `  Charlie balance: ${charlieInfo.balance}, logs: ${charlieInfo.logs.length}`,
  );
  console.log("  All balances:", allBalances);

  const allCorrect =
    aliceInfo.balance === expectedAliceBalance &&
    bobInfo.balance === expectedBobBalance &&
    charlieInfo.balance === expectedCharlieBalance &&
    aliceInfo.logs.length === 3 &&
    bobInfo.logs.length === 2 &&
    charlieInfo.logs.length === 2;

  if (!allCorrect) {
    throw new Error(
      "Functional test failed: balances or logs do not match expected values",
    );
  }

  console.log("FUNCTIONAL TEST PASSED");
  console.log("-".repeat(80) + "\n");
}

async function main(): Promise<void> {
  console.log("Starting load tests for assignment_3");
  console.log(`Facade URL: ${FACADE_URL}`);

  const results: TestResult[] = [];

  await runFunctionalTest();

  const scenarioOne = await runScenario(
    "10 clients, 10K transactions each to separate accounts",
    10,
    10000,
    (clientId) => `user-${clientId + 1}`,
    1,
  );
  results.push(scenarioOne);

  for (let index = 0; index < 10; index++) {
    const userId = `user-${index + 1}`;
    const balance = scenarioOne.finalBalances[userId] ?? 0;
    if (balance !== 10000) {
      throw new Error(
        `Scenario 1 failed for ${userId}: expected 10000, got ${balance}`,
      );
    }
  }

  const scenarioTwo = await runScenario(
    "10 clients, 10K transactions each to the same account",
    10,
    10000,
    () => "shared-account",
    1,
  );
  results.push(scenarioTwo);

  const sharedBalance = scenarioTwo.finalBalances["shared-account"] ?? 0;
  if (sharedBalance !== 100000) {
    throw new Error(
      `Scenario 2 failed for shared-account: expected 100000, got ${sharedBalance}`,
    );
  }

  console.log("\n" + "=".repeat(80));
  console.log("SUMMARY");
  console.log("=".repeat(80));
  for (const result of results) {
    console.log(`\n${result.scenario}:`);
    console.log(`  RPS: ${result.requestsPerSecond.toFixed(2)} req/s`);
    console.log(`  Time: ${result.totalTimeSeconds.toFixed(2)}s`);
    console.log(
      `  Success rate: ${((result.successfulRequests / result.totalRequests) * 100).toFixed(2)}%`,
    );
  }
  console.log("=".repeat(80) + "\n");
}

main().catch((error) => {
  console.error("Load test failed:", error);
  process.exit(1);
});
