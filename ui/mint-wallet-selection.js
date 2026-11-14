const UINT = /^(?:0|[1-9]\d{0,77})$/;
const MAX_BATCHES = 32n;
const ZERO_ADDRESS = '0x' + '0'.repeat(40);
const CLOSED_PHASES = new Set([2n, 4n, 5n, 6n]);

function uint(value) {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  return typeof value === 'string' && UINT.test(value) ? BigInt(value) : null;
}

const idle = () => ({ status: 'idle', needWei: 0n });
const unknown = (needWei = null) => ({ status: 'unknown', needWei });

/** Initial target for a new Mint project; null means no usable snapshot yet. */
export function mintDefaultBatches(project) {
  if (!project || project.error) return null;
  const phase = uint(project.phase);
  if (project.launched === true || project.emergencyWithdrawn === true || phase === 3n || CLOSED_PHASES.has(phase)) return 0;
  if (phase !== 1n || project.launched !== false || project.emergencyWithdrawn !== false) return null;
  const total = uint(project.totalLots);
  const issued = uint(project.mintedLots);
  if (total === null || total === 0n || issued === null || issued > total) return null;
  const left = total - issued;
  if (left === 0n) return 0;
  const cap = uint(project.maxMintsPerWallet);
  if (cap === null || cap === 0n) return null;
  return left < cap ? 1 : Number(cap > MAX_BATCHES ? MAX_BATCHES : cap);
}

/** Contract allowance for display, independent of the chosen target or BNB balance. */
export function mintWalletQuota(project, wallet) {
  if (!project || project.error) return null;
  const cap = uint(project.maxMintsPerWallet);
  const minted = uint(wallet?.mintedLots);
  if (cap === null || cap === 0n || minted === null) return null;
  const total = uint(project.totalLots);
  const issued = uint(project.mintedLots);
  const phase = uint(project.phase);
  const stop = project.launched === true || phase === 3n ? 'launched' :
    project.emergencyWithdrawn === true || CLOSED_PHASES.has(phase) ? 'closed' :
    total !== null && total > 0n && issued === total ? 'sold-out' : null;
  return { minted, cap, remaining: minted < cap ? cap - minted : 0n, stop };
}

/**
 * Conservative picker estimate only; transaction-time balance, gas, and
 * on-chain eligibility are still checked independently before signing.
 */
export function mintWalletFunding({ batches, autoClaim, project, wallet, gasWei } = {}) {
  const goal = uint(batches);
  if (goal === null || goal > MAX_BATCHES || typeof autoClaim !== 'boolean') return unknown();
  if (goal === 0n && !autoClaim) return idle();
  if (!project || project.error || typeof project.launched !== 'boolean' || typeof project.emergencyWithdrawn !== 'boolean') {
    return unknown();
  }
  if (project.emergencyWithdrawn) return idle();
  const phase = uint(project.phase);
  if (!project.launched) {
    if (CLOSED_PHASES.has(phase)) return idle(); // closed without launch; no claim
    if (phase !== 1n) return unknown();
  }

  let mints = 0n;
  let price = 0n;
  if (goal > 0n && !project.launched && project.agentOnly !== true) {
    const issued = uint(project.mintedLots);
    const total = uint(project.totalLots);
    if (issued === null || total === null || total === 0n || issued > total) return unknown();
    if (issued < total) {
      const cap = uint(project.maxMintsPerWallet);
      const count = uint(wallet?.mintedLots);
      if (cap === null || cap === 0n || count === null) return unknown();
      const target = goal < cap ? goal : cap;
      if (count < target) {
        const remaining = target - count;
        const available = total - issued;
        mints = remaining < available ? remaining : available;
        price = uint(project.pricePerLot);
        if (price === null || price === 0n) return unknown();
      }
    }
  }

  let claim = false;
  if (autoClaim) {
    if (mints > 0n) claim = true; // reserve gas for the share created by Mint
    else if (typeof wallet?.hasUnclaimedShare === 'boolean') claim = wallet.hasUnclaimedShare;
    else return unknown();
  }
  if (mints === 0n && !claim) return idle();

  const gas = uint(gasWei);
  if (gas === null || gas === 0n) return unknown();
  const token = typeof project.quoteToken === 'string' && /^0x[0-9a-f]{40}$/i.test(project.quoteToken) &&
    project.quoteToken.toLowerCase() !== ZERO_ADDRESS;
  if (token && mints > 0n) {
    const needQuote = mints * price;
    const allowance = uint(wallet?.quoteAllowance);
    const quoteBalance = uint(wallet?.quoteBalance);
    const approvals = allowance !== null && allowance >= needQuote ? 0n : allowance === 0n ? 1n : 2n;
    const needWei = (mints + approvals + (claim ? 1n : 0n)) * gas;
    const balance = uint(wallet?.balanceWei);
    return { status: balance === null || quoteBalance === null ? 'unknown' :
      balance >= needWei && quoteBalance >= needQuote ? 'sufficient' : 'insufficient', needWei, needQuote,
      approvalNeeded: approvals > 0n };
  }
  const needWei = mints * (price + gas) + (claim ? gas : 0n);
  const balance = uint(wallet?.balanceWei);
  return balance === null ? unknown(needWei) :
    { status: balance >= needWei ? 'sufficient' : 'insufficient', needWei };
}
