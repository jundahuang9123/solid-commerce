/**
 * Durable transaction ledger (SQLite via node:sqlite). Budget reservations
 * happen inside BEGIN IMMEDIATE transactions, so concurrent agents, or several
 * gateway processes sharing the file, cannot together exceed a mandate.
 *
 * Pod documents are evidence, synchronised from here. They are not the
 * source of truth for money.
 */
import { DatabaseSync } from "node:sqlite";

export type TxStatus = "authorized" | "pending" | "settled" | "released" | "rejected" | "refunded";
/** Statuses that consume budget. "pending" counts until reconciled; "refunded" (confirmed by the rail) does not. */
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
      );
      CREATE TABLE IF NOT EXISTS mandate_revisions (
        mandate_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, terms_digest TEXT NOT NULL, seen_at TEXT NOT NULL
      );`);
  }

  /**
   * High-water mark of user-signed mandate revisions. Every revision the gateway has verified is
   * recorded here; a revision below the highest one seen, or a different signed text at the same
   * revision, is refused. This stops an agent with Pod write access from putting back an older
   * signed revision (a higher limit the user has since lowered) once the gateway has seen the newer one.
   *
   * It cannot catch a rollback to a revision the gateway never saw superseded: if the agent restores
   * r1 before the gateway ever read r2, r1 is still the highest revision known here. Closing that
   * needs the user's device to tell the gateway (or a user-signed revision index somewhere agents
   * cannot write). It is also only as durable as this database: with the default ":memory:" ledger,
   * a gateway restart forgets every mark.
   */
  observeRevision(mandateId: string, revision: number, termsDigest: string): { ok: true } | { ok: false; code: string; reason: string } {
    return this.immediate(() => {
      const row = this.revisionOf(mandateId);
      if (row && revision < row.revision) return { ok: false as const, code: "MANDATE_SUPERSEDED", reason: `revision ${revision} was superseded by revision ${row.revision}` };
      if (row && revision === row.revision && termsDigest !== row.terms_digest) return { ok: false as const, code: "MANDATE_REVISION_CONFLICT", reason: `a different signed text of revision ${revision} was seen before` };
      if (!row || revision > row.revision) {
        this.db.prepare("INSERT INTO mandate_revisions (mandate_id, revision, terms_digest, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(mandate_id) DO UPDATE SET revision = excluded.revision, terms_digest = excluded.terms_digest, seen_at = excluded.seen_at")
          .run(mandateId, revision, termsDigest, new Date().toISOString());
      }
      return { ok: true as const };
    });
  }

  revisionOf(mandateId: string): { revision: number; terms_digest: string } | undefined {
    return this.db.prepare("SELECT revision, terms_digest FROM mandate_revisions WHERE mandate_id = ?").get(mandateId) as { revision: number; terms_digest: string } | undefined;
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

  /** Change fields other than the status (notes, evidence). Status changes go through `move`. */
  update(txId: string, fields: Partial<Omit<TxRow, "status">>) {
    this.write(txId, fields, []);
  }

  /**
   * Status transition, applied only if the row is still in one of `from`.
   * Every caller names the statuses it may leave, so a stale read or a
   * concurrent reconciliation can never move a row backwards (e.g. settled ->
   * released, which would free budget for money that moved). Returns whether it applied.
   */
  move(txId: string, from: TxStatus[], fields: Partial<TxRow> & { status: TxStatus }): boolean {
    return this.write(txId, fields, from);
  }

  private write(txId: string, fields: Partial<TxRow>, from: TxStatus[]): boolean {
    const f = { ...fields, updated_at: new Date().toISOString() };
    const cols = Object.keys(f);
    const guard = from.length ? ` AND status IN (${from.map(() => "?").join(",")})` : "";
    const r = this.db.prepare(`UPDATE transactions SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE tx_id = ?${guard}`).run(...(Object.values(f) as any[]), txId, ...from);
    if (r.changes > 0 && fields.status) this.event(txId, fields.status, fields.reason ?? undefined);
    return r.changes > 0;
  }

  /** A checkout session's authorization that still holds budget, if any (authorized, pending or settled). */
  liveCheckout(seller: string, sessionId: string): TxRow | undefined {
    return this.db.prepare(
      `SELECT * FROM transactions WHERE scheme = 'acp-delegated' AND seller = ? AND rail_reference = ? AND status IN (${COMMITTED.map(() => "?").join(",")}) LIMIT 1`,
    ).get(seller, sessionId, ...COMMITTED) as TxRow | undefined;
  }

  unresolved(): TxRow[] {
    return this.db.prepare("SELECT * FROM transactions WHERE status IN ('authorized','pending')").all() as unknown as TxRow[];
  }

  /** Settled checkout purchases, which can still be refunded (cancellation, return). */
  refundable(): TxRow[] {
    return this.db.prepare("SELECT * FROM transactions WHERE status = 'settled' AND scheme = 'acp-delegated'").all() as unknown as TxRow[];
  }

  event(txId: string, type: string, detail?: string) {
    this.db.prepare("INSERT INTO events (tx_id, at, type, detail) VALUES (?, ?, ?, ?)").run(txId, new Date().toISOString(), type, detail ?? null);
  }

  events(txId: string) {
    return this.db.prepare("SELECT at, type, detail FROM events WHERE tx_id = ? ORDER BY id").all(txId);
  }
}
