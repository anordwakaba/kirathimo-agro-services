import { Client, type QueryResultRow } from "pg";

type SqlTag = {
  (
    strings: TemplateStringsArray | readonly string[],
    ...values: unknown[]
  ): Promise<QueryResultRow[]>;
};

function buildQuery(
  strings: TemplateStringsArray | readonly string[],
  values: unknown[],
) {
  let text = "";

  for (let i = 0; i < strings.length; i++) {
    text += strings[i];

    if (i < values.length) {
      text += `$${i + 1}`;
    }
  }

  return { text, values };
}

export function createLocalSql(): SqlTag {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured.");
  }

  const url = new URL(databaseUrl);

  const host = process.env.LOCAL_DB_HOST;
  const endpointId = process.env.NEON_ENDPOINT_ID;

  if (!host) {
    throw new Error("LOCAL_DB_HOST is not configured.");
  }

  if (!endpointId) {
    throw new Error("NEON_ENDPOINT_ID is not configured.");
  }

  let client: Client | null = null;
  let connecting: Promise<Client> | null = null;

  async function getClient() {
    if (client) {
      return client;
    }

    if (connecting) {
      return connecting;
    }

    connecting = (async () => {
      const newClient = new Client({
        host,
        port: Number(url.port || 5432),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: url.pathname.slice(1),
        ssl: {
          rejectUnauthorized: false,
        },
        options: `endpoint=${endpointId}`,
        connectionTimeoutMillis: 10000,
      });

      await newClient.connect();
      client = newClient;

      return newClient;
    })();

    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  }

  return async (
    strings: TemplateStringsArray | readonly string[],
    ...values: unknown[]
  ) => {
    const db = await getClient();
    const query = buildQuery(strings, values);
    const result = await db.query(query.text, query.values);

    return result.rows;
  };
}
