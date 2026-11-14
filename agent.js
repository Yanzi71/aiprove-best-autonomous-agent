// Fully autonomous AIProve agent — no human in the loop.
//
// Loop: read skill.md -> authenticate with its own keypair -> list open
// bounties -> enter EVERY open bounty -> submit a prediction wherever it can
// form one from a real, fetched data source, and skip (with a logged reason)
// whatever it cannot verify.
//
// Prediction policies (documented, no fabrication):
//   - BTC/ETH yes-no direction (Brier): CoinGecko 24h change momentum.
//     change < -1% -> "no 0.55"; change > +1% -> "yes 0.55"; else "no 0.50"
//     (flat, max-entropy — never a confident call without evidence).
//   - ETH long/short (PnL): same momentum read -> "short" / "long".
//   - Number predictions (SPY/GLD/NVDA closes): SKIPPED — no reliable
//     keyless equity price feed is reachable; the agent never invents a price.
//   - top5-pons: SKIPPED — no live pons launch feed available.
//   - bug-hunt / repo / link bounties: ENTERED, submission skipped — they need
//     task-specific work (code review, a repo, creative output), logged.
//   - referral: ENTERED (entering is the whole entry).
//
// Usage: npm install && node agent.js
// Env: API_BASE_URL (default https://aiprove.fun), AGENT_PRIVATE_KEY
// (optional; otherwise a keypair is generated and saved to .agent-key.json,
// gitignored), AGENT_HANDLE (optional), DRY_RUN=1 (enter + log, no submits).
const fs = require('fs');
const { ethers } = require('ethers');

const API = process.env.API_BASE_URL || 'https://aiprove.fun';
const UA = 'AIProveAutonomousAgent/1.0 (Node)';
const DRY_RUN = process.env.DRY_RUN === '1';
const KEY_FILE = '.agent-key.json';

const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'user-agent': UA, 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* raw */ }
  if (!res.ok) throw new Error(`${res.status} ${url}: ${body.error || text.slice(0, 200)}`);
  return body;
}

function loadOrCreateKeypair() {
  if (process.env.AGENT_PRIVATE_KEY) return new ethers.Wallet(process.env.AGENT_PRIVATE_KEY);
  if (fs.existsSync(KEY_FILE)) {
    return new ethers.Wallet(JSON.parse(fs.readFileSync(KEY_FILE, 'utf8')).privateKey);
  }
  const w = ethers.Wallet.createRandom();
  fs.writeFileSync(KEY_FILE, JSON.stringify({ address: w.address, privateKey: w.privateKey }, null, 2), { mode: 0o600 });
  log('[key] generated new agent keypair:', w.address);
  return w;
}

async function cryptoMomentum() {
  // CoinGecko public API, no key. Returns { btc: {price, chg24}, eth: {...} }.
  const d = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true');
  return {
    btc: { price: d.bitcoin.usd, chg24: d.bitcoin.usd_24h_change },
    eth: { price: d.ethereum.usd, chg24: d.ethereum.usd_24h_change },
  };
}

function directionCall(chg24) {
  if (chg24 < -1) return 'no 0.55';
  if (chg24 > 1) return 'yes 0.55';
  return 'no 0.50';
}

async function main() {
  const t0 = Date.now();
  const results = { entered: [], submitted: [], skipped: [] };

  // 1. Read skill.md.
  const skill = await (await fetch(`${API}/skill.md`, { headers: { 'user-agent': UA } })).text();
  if (!skill.includes('/api/auth/challenge') || !skill.includes('/api/bounties')) {
    throw new Error('skill.md missing expected API instructions');
  }
  log(`[skill] read skill.md (${skill.length} bytes)`);

  // 2. Authenticate with our own keypair.
  const wallet = loadOrCreateKeypair();
  log('[auth] agent address:', wallet.address);
  const { challenge } = await fetchJson(`${API}/api/auth/challenge?address=${wallet.address}`);
  const signature = await wallet.signMessage(challenge);
  const { token } = await fetchJson(`${API}/api/auth/verify`, {
    method: 'POST',
    body: JSON.stringify({ address: wallet.address, signature }),
  });
  if (!token) throw new Error('auth verify returned no token');
  const auth = { authorization: `Bearer ${token}` };
  log('[auth] session token acquired');

  // 3. List open bounties + fetch live market data once.
  const { bounties } = await fetchJson(`${API}/api/bounties?status=open`);
  log(`[arena] ${bounties.length} open bounties`);
  let mkt = null;
  try {
    mkt = await cryptoMomentum();
    log(`[market] BTC $${mkt.btc.price} (${mkt.btc.chg24.toFixed(2)}% 24h), ETH $${mkt.eth.price} (${mkt.eth.chg24.toFixed(2)}% 24h)`);
  } catch (e) {
    log('[market] CoinGecko unreachable, direction calls fall back to flat 0.50:', e.message);
  }
  const btcCall = mkt ? directionCall(mkt.btc.chg24) : 'no 0.50';
  const ethCall = mkt ? directionCall(mkt.eth.chg24) : 'no 0.50';
  const ethSide = mkt ? (mkt.eth.chg24 < 0 ? 'short' : 'long') : 'long';

  // 4. Enter everything; submit where a real policy exists.
  const PREDICTION_POLICY = {
    'btc-tomorrow': btcCall,
    'forecast-btc-7d': btcCall,
    'forecast-eth-24h': ethCall,
    'signal-eth-pnl-24h': ethSide,
  };
  for (const b of bounties) {
    const slug = b.slug;
    try {
      const entry = await fetchJson(`${API}/api/bounties/${slug}/enter`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ handle: process.env.AGENT_HANDLE || undefined }),
      });
      results.entered.push({ slug, entryId: entry.id });
      log(`[enter] ${slug} -> ${entry.id}`);
    } catch (e) {
      results.skipped.push({ slug, reason: 'enter failed: ' + e.message });
      log(`[enter FAIL] ${slug}: ${e.message}`);
      continue;
    }
    const prediction = PREDICTION_POLICY[slug];
    if (prediction === undefined) {
      const reason = b.lane === 'PosterJudge'
        ? 'PosterJudge/link bounty: needs creative work, no autonomous submission policy'
        : /close|within|error/i.test(b.metric || '')
          ? 'number prediction: no reliable keyless price feed, will not invent a price'
          : /overlap|top 5/i.test(b.metric || '')
            ? 'needs a live pons launch feed, none available'
            : /bug/i.test(b.title + b.metric)
              ? 'bug hunt: needs task-specific code review'
              : b.submitKind === 'referral' || /referr/i.test(b.metric || '')
                ? 'referral bounty: entering is the whole entry'
                : 'repo bounty: needs a built repo, out of scope for this run';
      results.skipped.push({ slug, reason: 'submit skipped: ' + reason });
      log(`[skip submit] ${slug}: ${reason}`);
      continue;
    }
    if (DRY_RUN) {
      log(`[dry-run] would submit ${slug}: ${JSON.stringify(prediction)}`);
      continue;
    }
    try {
      const sub = await fetchJson(`${API}/api/bounties/${slug}/submit`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ handle: process.env.AGENT_HANDLE || undefined, prediction }),
      });
      results.submitted.push({ slug, prediction, submissionId: sub.id, status: sub.status });
      log(`[submit] ${slug}: ${JSON.stringify(prediction)} -> ${sub.id} (${sub.status})`);
    } catch (e) {
      results.skipped.push({ slug, reason: 'submit failed: ' + e.message });
      log(`[submit FAIL] ${slug}: ${e.message}`);
    }
  }

  const summary = {
    agent: wallet.address,
    durationMs: Date.now() - t0,
    entered: results.entered.length,
    submitted: results.submitted.length,
    skipped: results.skipped.length,
    results,
  };
  log(`[done] entered=${summary.entered} submitted=${summary.submitted} skipped=${summary.skipped} in ${summary.durationMs}ms`);
  fs.writeFileSync('last-run.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error('[error]', e.message || e); process.exit(1); });
