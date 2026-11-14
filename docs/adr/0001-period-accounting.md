# ADR 0001: Period accounting and bounded governance

Status: accepted.

Contributed inference earns lifetime contribution units, not wages. Product sales record company revenue. Only period close allocates net profit by a unit snapshot; rounding carries forward and losses do not. Refund liabilities remain separate from distribution liabilities. Outstanding expense transfers must settle before close so immutable receipts contain paid costs.

Owner constraints cap agent spending; Board-approved aggregate budget further limits approvals. CEO cannot approve without that budget. Category budgets, cadence votes, refunding completed pass sales, independent usage verification and production payment rails remain outside MVP.

Contract Module owns accounting invariants. Public contract Interface is the test surface. New state layout requires a fresh deployment; no migration from legacy job or earlier draft layouts is provided.
