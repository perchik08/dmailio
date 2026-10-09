import { randomUUID, createHash } from "node:crypto";
import { MarketingError, identifier, invalid } from "./contracts.mjs";

// Kept out of listmonk's public schema; every migration runs transactionally.
const migration = `
CREATE SCHEMA IF NOT EXISTS marketing;
CREATE TABLE IF NOT EXISTS marketing.schema_migrations (version int PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS marketing.documents (id uuid PRIMARY KEY, version int NOT NULL DEFAULT 1, data jsonb NOT NULL, archived boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS marketing.document_versions (document_id uuid NOT NULL REFERENCES marketing.documents(id), version int NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(document_id,version));
CREATE TABLE IF NOT EXISTS marketing.operations (id text PRIMARY KEY, fingerprint text NOT NULL, result jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS marketing.external_ids (kind text NOT NULL, external_id bigint NOT NULL, id uuid NOT NULL UNIQUE, metadata jsonb NOT NULL DEFAULT '{}', PRIMARY KEY(kind,external_id));
CREATE TABLE IF NOT EXISTS marketing.runs (id uuid PRIMARY KEY, version int NOT NULL DEFAULT 1, state text NOT NULL, document_id uuid REFERENCES marketing.documents(id), snapshot jsonb NOT NULL, scheduled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS marketing.recipients (id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES marketing.runs(id), contact_id uuid NOT NULL, email text NOT NULL, snapshot jsonb NOT NULL, state text NOT NULL DEFAULT 'queued', provider_message_id text, UNIQUE(run_id,contact_id));
CREATE TABLE IF NOT EXISTS marketing.events (id uuid PRIMARY KEY, recipient_id uuid NOT NULL REFERENCES marketing.recipients(id), provider_event_id text UNIQUE, kind text NOT NULL, data jsonb NOT NULL, occurred_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO marketing.schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING;
`;
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}
export class MarketingRepository {
  constructor(pool) {
    this.pool = pool;
  }
  async transaction(action) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async migrate() {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(73193301)");
      await client.query(migration);
    });
  }
  async health() {
    await this.pool.query(
      "SELECT version FROM marketing.schema_migrations WHERE version=1",
    );
    return true;
  }
  async document(id, client = this.pool) {
    const result = await client.query(
      "SELECT * FROM marketing.documents WHERE id=$1",
      [identifier(id)],
    );
    if (!result.rows.length)
      throw new MarketingError("NOT_FOUND", "Письмо не найдено", 404);
    return result.rows[0];
  }
  async createDocument(data) {
    const id = randomUUID();
    return this.transaction(async (client) => {
      const result = await client.query(
        "INSERT INTO marketing.documents(id,data) VALUES($1,$2) RETURNING *",
        [id, JSON.stringify(data)],
      );
      await client.query(
        "INSERT INTO marketing.document_versions(document_id,version,data) VALUES($1,1,$2)",
        [id, JSON.stringify(data)],
      );
      return result.rows[0];
    });
  }
  async updateDocument(id, expectedVersion, data) {
    identifier(id);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      throw invalid("Требуется сохранённая версия письма");
    return this.transaction(async (client) => {
      const result = await client.query(
        "UPDATE marketing.documents SET data=$3,version=version+1,updated_at=now() WHERE id=$1 AND version=$2 RETURNING *",
        [id, expectedVersion, JSON.stringify(data)],
      );
      if (!result.rows.length) {
        await this.document(id, client);
        throw new MarketingError(
          "VERSION_CONFLICT",
          "Письмо изменено в другой вкладке. Сохраните изменения как копию или загрузите новую версию.",
          409,
        );
      }
      const row = result.rows[0];
      await client.query(
        "INSERT INTO marketing.document_versions(document_id,version,data) VALUES($1,$2,$3)",
        [id, row.version, JSON.stringify(data)],
      );
      return row;
    });
  }
  async versions(id) {
    return (
      await this.pool.query(
        "SELECT version,data,created_at FROM marketing.document_versions WHERE document_id=$1 ORDER BY version",
        [identifier(id)],
      )
    ).rows;
  }
  async operation(id, payload, action) {
    if (typeof id !== "string" || !/^[\w-]{8,120}$/.test(id))
      throw invalid("Требуется идентификатор операции");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(stable(payload)))
      .digest("hex");
    return this.transaction(async (client) => {
      await client.query(
        "INSERT INTO marketing.operations(id,fingerprint) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [id, fingerprint],
      );
      const {
        rows: [row],
      } = await client.query(
        "SELECT * FROM marketing.operations WHERE id=$1 FOR UPDATE",
        [id],
      );
      if (row.fingerprint !== fingerprint)
        throw new MarketingError(
          "OPERATION_CONFLICT",
          "Этот идентификатор уже использован для другой операции",
          409,
        );
      if (row.result !== null) return row.result;
      const result = await action(client);
      await client.query(
        "UPDATE marketing.operations SET result=$2 WHERE id=$1",
        [id, JSON.stringify(result)],
      );
      return result;
    });
  }
  async operationResult(id) {
    const { rows } = await this.pool.query(
      "SELECT result FROM marketing.operations WHERE id=$1",
      [id],
    );
    if (!rows.length)
      throw new MarketingError("NOT_FOUND", "Операция не найдена", 404);
    return rows[0].result;
  }
}
