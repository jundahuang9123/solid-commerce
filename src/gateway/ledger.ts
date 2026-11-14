/**
 * Durable transaction ledger (SQLite via node:sqlite). Budget reservations
 * happen inside BEGIN IMMEDIATE transactions, so concurrent agents, or several
 * gateway processes sharing the file, cannot together exceed a mandate.
 *
 * Pod documents are evidence, synchronised from here. They are not the
 * source of truth for money.
 */
import { DatabaseSync } from "node:sqlite";

export type TxStatus = "authorized" | "pending" | "settled" | "released" | "rejected";
/** Statuses that consume budget. "pending" counts until reconciled. */
export const COMMITTED: TxStatus[] = ["authorized", "pending", "settled"];

export interface TxRow {
  tx_id: string; mandate_id: string; agent_id: string; seller: string; offer_id: string; offer_version: number;
  scheme: string; amount: string; currency: string; request_digest: string; status: TxStatus;
  auth_id: string | null; auth_json: string | null; rail_reference: string | null; payer: string | null;
  receipt_json: string | null; reason: string | null; created_at: string; updated_at: string; expires_at: string | null;
}

export class Ledger {
  readonly db: DatabaseSync;
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS transactions (
        tx_id TEXT PRIMARY KEY, mandate_id TEXT NOT NULL, agent_id TEXT NOT NULL, seller TEXT NOT NULL,
        offer_id TEXT NOT NULL, offer_version INTEGER NOT NULL, scheme TEXT NOT NULL,
        amount TEXT NOT NULL, currency TEXT NOT NULL, request_digest TEXT NOT NULL,
        status TEXT NOT NULL, auth_id TEXT UNIQUE, auth_json TEXT, rail_reference TEXT, payer TEXT,
        receipt_json TEXT, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS tx_mandate ON transactions(mandate_id, status);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, tx_id TEXT NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL, detail TEXT
      );`);
  }

  /** Run fn inside a write-locked transaction. */
  immediate<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const out = fn(); this.db.exec("COMMIT"); return out; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  get(txId: string): TxRow | undefined {
    return this.db.prepare("SELECT * FROM transactions WHERE tx_id = ?").get(txId) as TxRow | undefined;
  }

  committed(mandateId: string, currency: string): bigint {
    const rows = this.db.prepare(
      `SELECT amount FROM transactions WHERE mandate_id = ? AND currency = ? AND status IN (${COMMITTED.map(() => "?").join(",")})`,
    ).all(mandateId, currency, ...COMMITTED) as Array<{ amount: string }>;
    return rows.reduce((s, r) => s + BigInt(r.amount), 0n);
  }

  settled(mandateId: string, currency: string): bigint {
    const rows = this.db.prepare("SELECT amount FROM transactions WHERE mandate_id = ? AND currency = ? AND status = 'settled'").all(mandateId, currency) as Array<{ amount: string }>;
    return rows.reduce((s, r) => s + BigInt(r.amount), 0n);
  }

  insert(row: Omit<TxRow, "created_at" | "updated_at">) {
    const now = new Date().toISOString();
    const full = { ...row, created_at: now, updated_at: now };
    const cols = Object.keys(full);
    this.db.prepare(`INSERT INTO transactions (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`).run(...(Object.values(full) as any[]));
    this.event(row.tx_id, row.status, row.reason ?? undefined);
  }

  update(txId: string, fields: Partial<TxRow>) {
    const f = { ...fields, updated_at: new Date().toISOString() };
    const cols = Object.keys(f);
    this.db.prepare(`UPDATE transactions SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE tx_id = ?`).run(...(Object.values(f) as any[]), txId);
    if (fields.status) this.event(txId, fields.status, fields.reason ?? undefined);
  }

  unresolved(): TxRow[] {
    return this.db.prepare("SELECT * FROM transactions WHERE status IN ('authorized','pending')").all() as unknown as TxRow[];
  }

  event(txId: string, type: string, detail?: string) {
    this.db.prepare("INSERT INTO events (tx_id, at, type, detail) VALUES (?, ?, ?, ?)").run(txId, new Date().toISOString(), type, detail ?? null);
  }

  events(txId: string) {
    return this.db.prepare("SELECT at, type, detail FROM events WHERE tx_id = ? ORDER BY id").all(txId);
  }
}
