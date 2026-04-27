const fs = require('fs');
const path = require('path');

const CONFIG = {
  claimId: process.env.BITJITA_CLAIM_ID || 'PUT_CLAIM_ID_HERE',
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || 'PUT_DISCORD_WEBHOOK_URL_HERE',
  pollLimit: Number(process.env.BITJITA_LIMIT || '100'),
  notifyDeposits: true,
  notifyWithdraws: false,
  bitjitaBaseUrl: 'https://bitjita.com',
  stateFile: path.join(process.cwd(), 'bitjita_storage_state.json'),
};

if (!CONFIG.claimId || CONFIG.claimId === 'PUT_CLAIM_ID_HERE') {
  throw new Error('Set BITJITA_CLAIM_ID in GitHub Actions secrets or variables.');
}

if (!CONFIG.discordWebhookUrl || CONFIG.discordWebhookUrl === 'PUT_DISCORD_WEBHOOK_URL_HERE') {
  throw new Error('Set DISCORD_WEBHOOK_URL in GitHub Actions secrets.');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadState() {
  try {
    if (fs.existsSync(CONFIG.stateFile)) {
      const loaded = JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf8'));
      return {
        lastSeenLogIds: loaded.lastSeenLogIds || {},
        cachedBuildings: loaded.cachedBuildings || [],
        initialized: Boolean(loaded.initialized),
        updatedAt: loaded.updatedAt || null,
        recentProcessedLogIds: loaded.recentProcessedLogIds || [],
      };
    }
  } catch (err) {
    console.error('Failed to load state:', err);
  }

  return {
    lastSeenLogIds: {},
    cachedBuildings: [],
    initialized: false,
    updatedAt: null,
    recentProcessedLogIds: [],
  };
}

function saveState(state) {
  state.updatedAt = new Date().toISOString();

  // 念のため古いものを切り詰める
  if (!Array.isArray(state.recentProcessedLogIds)) {
    state.recentProcessedLogIds = [];
  }
  if (state.recentProcessedLogIds.length > 1000) {
    state.recentProcessedLogIds = state.recentProcessedLogIds.slice(-1000);
  }

  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2), 'utf8');
}

function hasProcessedLog(state, logId) {
  return (state.recentProcessedLogIds || []).includes(String(logId));
}

function markProcessedLog(state, logId) {
  const ids = new Set(state.recentProcessedLogIds || []);
  ids.add(String(logId));
  state.recentProcessedLogIds = Array.from(ids).slice(-1000);
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'bitjitabot/github-actions/1.0',
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status} for ${url}: ${text}`);
  }

  return await res.json();
}

function buildClaimInventoriesUrl() {
  return new URL(`/api/claims/${CONFIG.claimId}/inventories`, CONFIG.bitjitaBaseUrl).toString();
}

function buildStorageLogsUrl(buildingEntityId) {
  const url = new URL('/api/logs/storage', CONFIG.bitjitaBaseUrl);
  url.searchParams.set('buildingEntityId', String(buildingEntityId));
  url.searchParams.set('limit', String(CONFIG.pollLimit));
  return url.toString();
}

async function fetchClaimBuildings() {
  const payload = await fetchJson(buildClaimInventoriesUrl());

  let buildings = [];
  if (Array.isArray(payload?.buildings)) {
    buildings = payload.buildings;
  } else if (payload?.buildings && typeof payload.buildings === 'object') {
    buildings = Object.values(payload.buildings);
  }

  return buildings
    .map((b) => ({
      entityId: String(b.entityId ?? b.id ?? ''),
      name:
        b.buildingNickname ||
        b.nickname ||
        b.customName ||
        b.displayName ||
        b.buildingName ||
        b.name ||
        'Unknown Building',
    }))
    .filter((b) => b.entityId);
}

function buildItemMaps(payload) {
  const itemMap = new Map();
  const cargoMap = new Map();

  for (const item of payload.items || []) {
    itemMap.set(String(item.id), item.name);
  }

  for (const cargo of payload.cargos || []) {
    cargoMap.set(String(cargo.id), cargo.name);
  }

  return { itemMap, cargoMap };
}

function getItemName(log, maps) {
  const itemId = String(log?.data?.item_id ?? '');
  const itemType = log?.data?.item_type;

  if (itemType === 'cargo') {
    return maps.cargoMap.get(itemId) || `Cargo ${itemId}`;
  }

  return maps.itemMap.get(itemId) || `Item ${itemId}`;
}

function shouldNotify(log) {
  const type = log?.data?.type;

  if (type === 'deposit_item') return CONFIG.notifyDeposits;
  if (type === 'withdraw_item') return CONFIG.notifyWithdraws;

  return false;
}

function formatLogMessage(log, maps, fallbackBuildingName) {
  const type = log?.data?.type;
  const playerName = log?.subjectName || 'Unknown';
  const quantity = log?.data?.quantity ?? 0;
  const itemName = getItemName(log, maps);
  const buildingName = fallbackBuildingName || log?.building?.buildingName || 'Unknown Building';

  if (type === 'deposit_item') {
    return `📦 納品通知\n${playerName} が **${itemName}** を **${quantity}個** 納品しました\n建物: ${buildingName}`;
  }

  if (type === 'withdraw_item') {
    return `📤 引き出し通知\n${playerName} が **${itemName}** を **${quantity}個** 引き出しました\n建物: ${buildingName}`;
  }

  return null;
}

async function sendDiscordWebhook(content) {
  const res = await fetch(CONFIG.discordWebhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord webhook failed: HTTP ${res.status}: ${text}`);
  }
}

async function pollBuildingLogs(building, state, isFirstRun) {
  const url = buildStorageLogsUrl(building.entityId);
  const payload = await fetchJson(url);
  const logs = Array.isArray(payload.logs) ? payload.logs : [];

  if (logs.length === 0) {
    return 0;
  }

  const maps = buildItemMaps(payload);
  const sorted = logs
    .slice()
    .filter((x) => x && x.id != null)
    .sort((a, b) => Number(a.id) - Number(b.id));

  const newestId = String(sorted[sorted.length - 1].id);
  const previousId = state.lastSeenLogIds[building.entityId] || null;

  if (isFirstRun && !previousId) {
    state.lastSeenLogIds[building.entityId] = newestId;
    return 0;
  }

  const prevNum = previousId ? Number(previousId) : null;
  const newLogs = sorted.filter((log) => {
    if (prevNum == null) return true;
    return Number(log.id) > prevNum;
  });

  let sentCount = 0;

  for (const log of newLogs) {
    if (!shouldNotify(log)) continue;

    if (hasProcessedLog(state, log.id)) {
      console.log(`Skipping duplicate log ${log.id}`);
      continue;
    }

    const msg = formatLogMessage(log, maps, building.name);
    if (!msg) continue;

    console.log(`Sending notification for building ${building.entityId}, log ${log.id}`);
    await sendDiscordWebhook(msg);
    markProcessedLog(state, log.id);
    sentCount++;
    await sleep(300);
  }

  state.lastSeenLogIds[building.entityId] = newestId;
  return sentCount;
}

async function main() {
  const state = loadState();
  const buildings = await fetchClaimBuildings();

  if (!buildings.length) {
    throw new Error(`No buildings found for claim ${CONFIG.claimId}`);
  }

  state.cachedBuildings = buildings;

  const isFirstRun = !state.initialized;
  console.log(`Loaded ${buildings.length} buildings for claim ${CONFIG.claimId}`);

  let totalSent = 0;

  for (const building of buildings) {
    try {
      const sent = await pollBuildingLogs(building, state, isFirstRun);
      totalSent += sent;
      await sleep(150);
    } catch (err) {
      console.error(`Failed building ${building.entityId}: ${err.message}`);
    }
  }

  state.initialized = true;
  saveState(state);

  console.log(`Notifications sent: ${totalSent}`);
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
