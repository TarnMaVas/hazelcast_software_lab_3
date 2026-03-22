import Fastify from "fastify";
import { Pool, type PoolClient } from "pg";

interface TransactionBody {
  transaction_ID: string;
  timestamp: string;
  user_Id: string;
  amount: number;
}

const app = Fastify({ logger: true });

const PORT = Number(process.env.PORT ?? "3002");
const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://bank:bankpass@localhost:5432/banking";

const pool = new Pool({
  connectionString: DATABASE_URL,
});

async function bootstrapSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      user_id TEXT PRIMARY KEY,
      balance NUMERIC NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS applied_transactions (
      transaction_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL
    )
  `);
}

async function waitForDatabase(): Promise<void> {
  const maxAttempts = 20;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query("SELECT 1");
      await bootstrapSchema();
      app.log.info({ attempt }, "Connected to PostgreSQL");
      return;
    } catch (error) {
      app.log.warn(
        { err: error, attempt },
        "PostgreSQL connection attempt failed",
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  throw new Error("Unable to connect to PostgreSQL");
}

async function withTransaction<T>(
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

app.post<{ Body: TransactionBody }>("/transaction", async (req) => {
  const { transaction_ID, timestamp, user_Id, amount } = req.body;

  const balance = await withTransaction(async (client) => {
    const insertedTransaction = await client.query(
      `
        INSERT INTO applied_transactions (transaction_id, user_id, amount, timestamp)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (transaction_id) DO NOTHING
        RETURNING transaction_id
      `,
      [transaction_ID, user_Id, amount, timestamp],
    );

    if ((insertedTransaction.rowCount ?? 0) > 0) {
      const updatedAccount = await client.query<{ balance: string }>(
        `
          INSERT INTO accounts (user_id, balance, updated_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (user_id) DO UPDATE
          SET balance = accounts.balance + EXCLUDED.balance,
              updated_at = NOW()
          RETURNING balance
        `,
        [user_Id, amount],
      );

      const nextBalance = Number(updatedAccount.rows[0]?.balance ?? "0");
      app.log.info(
        { transaction_ID, user_Id, amount, balance: nextBalance },
        "Applied transaction to PostgreSQL balance",
      );
      return nextBalance;
    }

    const currentAccount = await client.query<{ balance: string }>(
      "SELECT balance FROM accounts WHERE user_id = $1",
      [user_Id],
    );

    const currentBalance = Number(currentAccount.rows[0]?.balance ?? "0");
    app.log.info(
      { transaction_ID, user_Id, balance: currentBalance },
      "Ignored duplicate transaction",
    );
    return currentBalance;
  });

  return { balance };
});

app.get<{ Params: { user_Id: string }; Reply: { balance: number } }>(
  "/balance/:user_Id",
  async (req) => {
    const { user_Id } = req.params;
    const result = await pool.query<{ balance: string }>(
      "SELECT balance FROM accounts WHERE user_id = $1",
      [user_Id],
    );

    const balance = Number(result.rows[0]?.balance ?? "0");
    app.log.info({ user_Id, balance }, "Returning balance");
    return { balance };
  },
);

app.get<{ Reply: Record<string, number> }>("/balances", async () => {
  const result = await pool.query<{ user_id: string; balance: string }>(
    "SELECT user_id, balance FROM accounts ORDER BY user_id ASC",
  );

  const balances = Object.fromEntries(
    result.rows.map((row) => [row.user_id, Number(row.balance)]),
  );

  app.log.info({ count: result.rowCount }, "Returning all balances");
  return balances;
});

app.post("/reset", async () => {
  await withTransaction(async (client) => {
    await client.query("TRUNCATE TABLE applied_transactions, accounts");
  });
  app.log.info("Reset PostgreSQL state");
  return { ok: true };
});

async function start() {
  try {
    await waitForDatabase();
    await app.listen({ port: PORT, host: "0.0.0.0" });
    app.log.info({ port: PORT }, "Counter service is running");
  } catch (error) {
    app.log.error({ err: error }, "Failed to start counter service");
    process.exit(1);
  }
}

start();
