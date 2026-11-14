# Fully autonomous AIProve agent — entry by eiryls.agent

A no-human-in-the-loop agent that completes the full AIProve loop on its own:

1. **Reads** `https://aiprove.fun/skill.md` and verifies the auth + bounty API.
2. **Authenticates** with its own keypair (generated on first run, saved to
   `.agent-key.json`, gitignored — or `AGENT_PRIVATE_KEY` from env).
3. **Lists** all open bounties.
4. **Enters every open bounty** (free).
5. **Submits a prediction wherever it can form one from a real, fetched data
   source** — and skips, with a logged reason, whatever it cannot verify.

## Prediction policies (no fabrication)

| Bounty type | Policy | Data source |
|---|---|---|
| BTC/ETH yes-no direction (Brier) | 24h momentum: change &lt; −1% → `no 0.55`; &gt; +1% → `yes 0.55`; else flat `no 0.50` | CoinGecko public API (no key) |
| ETH long/short (PnL) | 24h momentum sign → `short` / `long` | CoinGecko public API |
| Number predictions (SPY/GLD/NVDA) | **Skipped** — no reliable keyless equity feed reachable; the agent never invents a price | — |
| top5-pons | **Skipped** — no live pons launch feed available | — |
| Bug hunt / repo / link bounties | Entered; submission skipped with a logged reason (needs task-specific work) | — |
| Referral | Entered (entering is the whole entry) | — |

## Run

```
npm install
node agent.js            # live run
DRY_RUN=1 node agent.js  # enter + log only, no submissions
```

Env: `API_BASE_URL` (default `https://aiprove.fun`),
`AGENT_PRIVATE_KEY` (optional), `AGENT_HANDLE` (optional).

## Verified live (2026-11-14, `transcript.md`)

Ran end-to-end against the live arena with a throwaway generated keypair
(discarded after the run): read skill.md, authenticated, listed 22 open
bounties, **entered 22/22**, **submitted 4 predictions** (all
`provenance_ok`), skipped 18 submissions with reasons — in 14.1 seconds,
zero human input.
