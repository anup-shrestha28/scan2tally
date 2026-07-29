/**
 * Features that are built but not switched on yet.
 */

/**
 * Matching handwritten ledger names against the company's Tally chart of accounts.
 *
 * Off for now. With it off the app behaves exactly as it did before the feature
 * existed: ledger names are exported precisely as they were written on the
 * voucher, and nothing about ledgers appears in the interface.
 *
 * Turning it on is this one line — but it ALSO requires
 * scripts/migrations/002_ledgers_claiming_audit.sql to have been run against the
 * database, because the columns it reads and writes arrive with that migration.
 * That is the whole reason this flag gates the database queries too and not just
 * the buttons: PostgREST fails an entire query when asked for a column that does
 * not exist, so a screen that merely LOOKED hidden would still have broken every
 * read of the transactions table.
 */
export const LEDGER_MATCHING = false;
