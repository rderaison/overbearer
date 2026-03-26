import { createCipheriv, randomBytes } from "node:crypto";

export interface ProxyLogEntry {
  timestamp: Date;
  service_name: string;
  service_ip: string;
  target_host: string;
  target_path: string;
  method: string;
  token_type: string;
  token_id: string;
  token_preview: string;
  token_full: string;
  response_status: number;
  latency_ms: number;
}

const FLUSH_INTERVAL_MS = 1_000;
const FLUSH_BATCH_SIZE = 100;

let masterKey: Buffer | undefined;
let buffer: ProxyLogEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | undefined;
let flushing = false;
let mode: "kafka" | "clickhouse" = "clickhouse";

// Kafka state
let kafkaProducer: any;
let kafkaTopic: string;

// ClickHouse state
let chClient: any;

const validTypes = new Set(["fake", "real_direct", "unknown", "acl_denied"]);

function encryptField(value: string): string {
  if (!masterKey || !value) return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function formatRow(entry: ProxyLogEntry) {
  return {
    timestamp: entry.timestamp.toISOString().replace("T", " ").replace("Z", ""),
    service_name: entry.service_name,
    service_ip: entry.service_ip,
    target_host: entry.target_host,
    target_path: entry.target_path,
    method: entry.method,
    token_type: validTypes.has(entry.token_type) ? entry.token_type : "real_direct",
    token_id: entry.token_id,
    token_preview: encryptField(entry.token_preview),
    token_encrypted: encryptField(entry.token_full),
    response_status: entry.response_status,
    latency_ms: Math.round(entry.latency_ms),
  };
}

/**
 * Initialize log shipping. Uses Kafka if KAFKA_BROKERS is set, otherwise direct ClickHouse.
 */
export function initClickHouse(): void {
  const keyHex = process.env.OVERBEARER_MASTER_KEY;
  if (keyHex) {
    masterKey = Buffer.from(keyHex, "hex");
  }

  const kafkaBrokers = process.env.KAFKA_BROKERS;

  if (kafkaBrokers) {
    mode = "kafka";
    kafkaTopic = process.env.KAFKA_TOPIC ?? "overbearer.proxy-logs";
    initKafka(kafkaBrokers.split(","));
  } else {
    mode = "clickhouse";
    initDirectClickHouse();
  }

  flushTimer = setInterval(() => {
    void flush();
  }, FLUSH_INTERVAL_MS);

  if (flushTimer && typeof flushTimer === "object" && "unref" in flushTimer) {
    flushTimer.unref();
  }
}

function initKafka(brokers: string[]): void {
  import("kafkajs").then(({ Kafka }) => {
    const kafka = new Kafka({
      clientId: "overbearer-proxy",
      brokers,
      retry: { retries: 3, initialRetryTime: 300 },
    });

    kafkaProducer = kafka.producer({
      allowAutoTopicCreation: false,
      maxInFlightRequests: 5,
    });

    void kafkaProducer.connect().then(() => {
      console.log("[kafka] producer connected");
    }).catch((err: unknown) => {
      console.error("[kafka] connect failed:", err instanceof Error ? err.message : err);
    });
  }).catch((err) => {
    console.error("[kafka] failed to load kafkajs:", err instanceof Error ? err.message : err);
    console.log("[kafka] falling back to direct ClickHouse");
    mode = "clickhouse";
    initDirectClickHouse();
  });
}

function initDirectClickHouse(): void {
  const url = process.env.CLICKHOUSE_URL ?? "http://localhost:8123";
  const database = process.env.CLICKHOUSE_DATABASE ?? "overbearer";

  import("@clickhouse/client").then(({ createClient }) => {
    chClient = createClient({
      url,
      database,
      clickhouse_settings: {
        async_insert: 1,
        wait_for_async_insert: 1,
      },
    });
    console.log(`[clickhouse] direct client initialized (${url})`);
  }).catch((err) => {
    console.error("[clickhouse] failed to initialize:", err instanceof Error ? err.message : err);
  });
}

export function log(entry: ProxyLogEntry): void {
  buffer.push(entry);
  if (buffer.length >= FLUSH_BATCH_SIZE) {
    void flush();
  }
}

async function flush(): Promise<void> {
  if (flushing || buffer.length === 0) return;

  flushing = true;
  const batch = buffer;
  buffer = [];

  try {
    if (mode === "kafka" && kafkaProducer) {
      await kafkaProducer.send({
        topic: kafkaTopic,
        messages: batch.map((entry) => ({
          value: JSON.stringify(formatRow(entry)),
        })),
      });
      console.log(`[kafka] sent ${batch.length} entries`);
    } else if (mode === "clickhouse" && chClient) {
      await chClient.insert({
        table: "proxy_logs",
        values: batch.map(formatRow),
        format: "JSONEachRow",
      });
      console.log(`[clickhouse] inserted ${batch.length} entries`);
    } else {
      // Neither ready yet — put back
      buffer = batch.concat(buffer);
      return;
    }
  } catch (err) {
    console.error(
      `[${mode}] flush failed:`,
      err instanceof Error ? err.message : err,
    );
    if (buffer.length + batch.length <= 10_000) {
      buffer = batch.concat(buffer);
    } else {
      console.warn(`[${mode}] dropping ${batch.length} entries (buffer full)`);
    }
  } finally {
    flushing = false;
  }
}

export async function shutdownClickHouse(): Promise<void> {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = undefined;
  }

  flushing = false;
  await flush();

  if (mode === "kafka" && kafkaProducer) {
    await kafkaProducer.disconnect();
    kafkaProducer = undefined;
  }
  if (mode === "clickhouse" && chClient) {
    await chClient.close();
    chClient = undefined;
  }
}
