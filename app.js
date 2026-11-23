/**
 * LMDB Hydroponics — Seed & System Catalog Web Application
 * Connects live to Cloud Firestore (`seed_catalog`, `system_catalog`, and active farm `systems`),
 * with automatic fallback to GitHub Raw Catalog or local `seed-catalog.json` / `system-catalog.json`.
 */

const DEFAULT_SETTINGS = {
  sourceMode: 'auto', // 'auto' | 'firestore' | 'github' | 'local'
  firebaseProjectId: 'lmdb-hydroponics',
  firebaseApiKey: 'AIzaSyBDjm1PuPLwJ2BZBgtsIXOSB4pOyJWJZz0',
  includeActiveFarm: true,
  ghOwner: 'lucasbouter',
  ghRepo: 'LmdbHydroponics-Catalog',
  ghBranch: 'main',
};

const STORAGE_KEY_SETTINGS = 'lmdb_catalog_web_settings_v1';
const STORAGE_KEY_THEME = 'lmdb_catalog_web_theme_v1';

const STAGE_COLORS = ['#a8d5a2', '#34d399', '#10b981', '#38bdf8', '#fbbf24', '#f97316', '#ef4444'];

const state = {
  settings: loadSettings(),
  activeTab: 'seeds', // 'seeds' | 'systems' | 'compare'
  seeds: [],
  systems: [],
  seedSearch: '',
  seedCategory: 'All',
  seedSort: 'name_asc',
  systemSearch: '',
  systemType: 'All',
  systemSort: 'name_asc',
  activeModalItem: null, // { kind: 'seed' | 'system', data: ... }
  connectionSource: 'Initializing...',
  lastSyncedAt: null,
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SETTINGS);
    if (raw) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    }
  } catch (e) {
    console.warn('Could not load saved settings:', e);
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(newSettings) {
  state.settings = { ...DEFAULT_SETTINGS, ...newSettings };
  try {
    localStorage.setItem(STORAGE_KEY_SETTINGS, JSON.stringify(state.settings));
  } catch (e) {
    console.warn('Could not persist settings:', e);
  }
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSimpleMarkdown(text) {
  if (!text) return '';
  const escaped = escapeHtml(text);
  return escaped
    .replace(/^###\s+(.+)$/gm, '<strong style="display:block;margin-top:8px;color:var(--primary);">$1</strong>')
    .replace(/^##\s+(.+)$/gm, '<strong style="display:block;margin-top:10px;font-size:15px;color:var(--primary);">$1</strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function parseHarvestingInstructions(instructionsText, methodsList) {
  if (!instructionsText || !instructionsText.trim()) return {};
  const result = {};
  const methods = (methodsList || []).filter(Boolean);
  if (methods.length <= 1) {
    result[methods[0] || 'General'] = instructionsText.trim();
    return result;
  }
  const lines = instructionsText.split(/\r?\n/);
  let currentMethod = 'General';
  let buffer = [];

  const flush = () => {
    const joined = buffer.join('\n').trim();
    if (joined) {
      result[currentMethod] = result[currentMethod]
        ? `${result[currentMethod]}\n\n${joined}`
        : joined;
    }
    buffer = [];
  };

  for (const line of lines) {
    const headerMatch = line.match(/^(?:##+|✂️|\*\*)\s*([^:*#]+?)[\s:*]*$/);
    if (headerMatch) {
      const candidate = headerMatch[1].trim();
      const matched = methods.find((m) => m.toLowerCase() === candidate.toLowerCase());
      if (matched) {
        flush();
        currentMethod = matched;
        continue;
      }
    }
    buffer.push(line);
  }
  flush();
  return Object.keys(result).length > 0 ? result : { General: instructionsText.trim() };
}

// ─── Firestore REST Parsing Helpers ──────────────────────────────────────────

function parseFirestoreVal(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(parseFirestoreVal);
  if ('mapValue' in v) {
    const obj = {};
    for (const [k, val] of Object.entries(v.mapValue.fields || {})) {
      obj[k] = parseFirestoreVal(val);
    }
    return obj;
  }
  return null;
}

function parseFirestoreDoc(doc) {
  const obj = { _id: doc.name.split('/').pop() };
  for (const [k, v] of Object.entries(doc.fields || {})) {
    obj[k] = parseFirestoreVal(v);
  }
  return obj;
}

async function fetchFromFirestore() {
  const { firebaseProjectId, firebaseApiKey, includeActiveFarm } = state.settings;
  if (!firebaseProjectId) {
    throw new Error('Firebase Project ID is not configured.');
  }

  let headers = {};
  if (firebaseApiKey) {
    try {
      const authRes = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(firebaseApiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ returnSecureToken: true }),
        },
      );
      if (authRes.ok) {
        const authData = await authRes.json();
        if (authData.idToken) {
          headers = { Authorization: `Bearer ${authData.idToken}` };
        }
      }
    } catch (e) {
      console.warn('Anonymous Firebase Auth fallback warning:', e);
    }
  }

  async function getCol(colName) {
    const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(firebaseProjectId)}/databases/(default)/documents/${colName}?pageSize=300`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      throw new Error(`Firestore HTTP ${res.status} on ${colName}`);
    }
    const data = await res.json();
    return (data.documents || []).map(parseFirestoreDoc);
  }

  const baseCols = await Promise.all([
    getCol('seed_catalog'),
    getCol('system_catalog'),
  ]);

  let seedPackages = [];
  let systems = [];
  let stations = [];
  let stages = [];
  let channels = [];
  let tanks = [];
  let lights = [];
  let pumps = [];

  if (includeActiveFarm) {
    [seedPackages, systems, stations, stages, channels, tanks, lights, pumps] = await Promise.all([
      getCol('seed_packages').catch(() => []),
      getCol('systems').catch(() => []),
      getCol('stations').catch(() => []),
      getCol('system_grow_stages').catch(() => []),
      getCol('channels').catch(() => []),
      getCol('tanks').catch(() => []),
      getCol('grow_lights').catch(() => []),
      getCol('pumps').catch(() => []),
    ]);
  }

  const [seedCatalog, systemCatalog] = baseCols;

  const cleanSeeds = seedCatalog
    .filter((s) => !s.isDeleted && s.status !== 'rejected' && s.name)
    .map((s) => ({
      catalogId: s.catalogId || s._id,
      sourceType: 'catalog',
      ...s,
    }));

  if (includeActiveFarm) {
    for (const pkg of seedPackages.filter((p) => !p.isDeleted && p.name)) {
      const exists = cleanSeeds.some(
        (s) => (s.name || '').trim().toLowerCase() === (pkg.name || '').trim().toLowerCase(),
      );
      if (!exists) {
        cleanSeeds.push({
          catalogId: pkg.cloudId || pkg._id,
          sourceType: 'active_farm_seed',
          name: pkg.name,
          type: pkg.type || '',
          category: pkg.category || '',
          harvestMethod: pkg.harvestMethod || '',
          brand: pkg.brand || '',
          seedTypeSpacingCm: pkg.seedTypeSpacingCm ?? null,
          daysToHarvest: pkg.daysToHarvest || 0,
          daysSeedsLastInStorage: pkg.daysSeedsLastInStorage ?? pkg.shelfLifeDays ?? null,
          shelfLifeDays: pkg.shelfLifeDays ?? pkg.daysSeedsLastInStorage ?? null,
          plantingInstructions: pkg.plantingInstructions || '',
          harvestingInstructions: pkg.harvestingInstructions || '',
          harvestedStorageInstructions: pkg.harvestedStorageInstructions || '',
          notes: pkg.notes || '',
          photoUri: pkg.photoUri || null,
          growStages: Array.isArray(pkg.growStages) ? pkg.growStages : [],
          updatedAt: pkg.updatedAt,
        });
      }
    }
  }

  const assembledSystems = systemCatalog
    .filter((s) => !s.isDeleted && s.status !== 'rejected' && s.name)
    .map((s) => ({
      catalogId: s.catalogId || s._id,
      sourceType: 'catalog',
      ...s,
    }));

  if (includeActiveFarm) {
    for (const sys of systems.filter((s) => !s.isDeleted && s.name)) {
      const exists = assembledSystems.some(
        (x) => (x.name || '').trim().toLowerCase() === (sys.name || '').trim().toLowerCase(),
      );
      if (exists) continue;

      const sysStations = stations
        .filter(
          (st) =>
            !st.isDeleted &&
            (st.system_cloudId === sys.cloudId || st.system_name === sys.name),
        )
        .sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0))
        .map((st) => {
          const stChannels = channels
            .filter(
              (c) =>
                !c.isDeleted &&
                (c.station_cloudId === st.cloudId || c.station_name === st.name),
            )
            .sort((a, b) =>
              String(a.label || '').localeCompare(String(b.label || ''), undefined, { numeric: true }),
            )
            .map((c) => ({
              channelType: c.channelType || 'Germination and Seedling',
              label: String(c.label || ''),
              lengthCm: c.lengthCm ?? null,
              plugCapacity: c.plugCapacity || 0,
              seedTypeSpacingCm: c.seedTypeSpacingCm ?? null,
              withDome: c.withDome ? 1 : 0,
              domeLengthCm: c.domeLengthCm ?? null,
              withHeat: c.withHeat ? 1 : 0,
              withWatering: c.withWatering ? 1 : 0,
              wateringLengthCm: c.wateringLengthCm ?? null,
              dripFlowRateMlPerMin: c.dripFlowRateMlPerMin ?? null,
            }));

          const stTanks = tanks
            .filter(
              (t) =>
                !t.isDeleted &&
                (t.station_cloudId === st.cloudId || t.station_name === st.name),
            )
            .map((t) => ({
              name: t.name,
              type: t.type || 'Full Growth Nutrient',
              pairKey: t.pairKey ?? null,
              isActive: t.isActive ?? 1,
              volumeLiters: t.volumeLiters ?? null,
              desiredPh: t.desiredPh ?? null,
              desiredEc: t.desiredEc ?? null,
              desiredNutrientSolutionMl: t.desiredNutrientSolutionMl ?? null,
              tankFillingInstructions: t.tankFillingInstructions || '',
              notes: t.notes || '',
            }));

          const stLights = lights
            .filter(
              (l) =>
                !l.isDeleted &&
                (l.station_cloudId === st.cloudId || l.station_name === st.name),
            )
            .map((l) => ({
              name: l.name,
              brandModel: l.brandModel || '',
              wattage: l.wattage ?? null,
              spectrumType: l.spectrumType || '',
              ppfdRating: l.ppfdRating ?? null,
              lightHours: l.lightHours ?? null,
              dimmerPercent: l.dimmerPercent ?? 100,
              notes: l.notes || '',
              scheduleMode: l.scheduleMode || 'daily_time',
              onTime: l.onTime || null,
              offTime: l.offTime || null,
            }));

          const stPumps = pumps
            .filter(
              (p) =>
                !p.isDeleted &&
                (p.station_cloudId === st.cloudId || p.station_name === st.name),
            )
            .map((p) => ({
              name: p.name,
              tankName: p.tank_name || null,
              scheduleMode: p.scheduleMode || 'disabled',
              runDurationValue: p.runDurationValue ?? null,
              runDurationUnit: p.runDurationUnit || 'minutes',
              cycleIntervalValue: p.cycleIntervalValue ?? null,
              cycleIntervalUnit: p.cycleIntervalUnit || 'minutes',
              onTime: p.onTime || null,
              offTime: p.offTime || null,
              activeStartTime: p.activeStartTime || null,
              activeEndTime: p.activeEndTime || null,
              connectedChannelLabels: Array.isArray(p.connectedChannelLabels)
                ? p.connectedChannelLabels
                : [],
              notes: p.notes || '',
            }));

          return {
            name: st.name,
            type: st.type || 'NFT',
            purpose: st.purpose || '',
            orderIndex: st.orderIndex ?? 0,
            containerType: st.containerType || 'Grow Plug',
            transplantRequired: !!st.transplantRequired,
            desiredEc: st.desiredEc ?? (stTanks.find((t) => t.desiredEc != null)?.desiredEc ?? null),
            desiredPh: st.desiredPh ?? (stTanks.find((t) => t.desiredPh != null)?.desiredPh ?? null),
            notes: st.notes || '',
            channels: stChannels,
            tanks: stTanks,
            growLights: stLights,
            pumps: stPumps,
            initialChannelCount: stChannels.length,
          };
        });

      const sysStages = stages
        .filter((stg) => !stg.isDeleted && stg.system_name === sys.name)
        .sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0))
        .map((stg) => ({
          stageName: stg.stageName,
          stageDescription: stg.stageDescription || '',
          stageDescriptionShort: stg.stageDescriptionShort || '',
          stageDescriptionLong: stg.stageDescriptionLong || '',
          containerType: stg.containerType || 'Grow Plug',
          transplantRequired: !!stg.transplantRequired,
          daysInStageMin: stg.daysInStageMin ?? 0,
          daysInStageMax: stg.daysInStageMax ?? 0,
          orderIndex: stg.orderIndex ?? 0,
          targetDripVolumeMinMl: stg.targetDripVolumeMinMl ?? 0,
          targetDripVolumeMaxMl: stg.targetDripVolumeMaxMl ?? 0,
          desiredEc: stg.desiredEc ?? null,
          desiredPh: stg.desiredPh ?? null,
          dosingRateMlPerL: stg.dosingRateMlPerL ?? null,
          dripShots: Array.isArray(stg.dripShots) ? stg.dripShots : [],
          reminders: Array.isArray(stg.reminders) ? stg.reminders : [],
        }));

      const matchedSeed = cleanSeeds.find(
        (s) => (s.name || '').trim().toLowerCase() === (sys.seed_name || '').trim().toLowerCase(),
      );

      assembledSystems.push({
        catalogId: sys.cloudId || sys._id,
        sourceType: 'active_farm_system',
        name: sys.name,
        type: sys.type || 'NFT',
        farmerObjective: sys.farmerObjective || '',
        harvestType: sys.harvestType || 'Full Head',
        harvestFullHeadCount: sys.harvestFullHeadCount ?? null,
        harvestFullHeadEveryDays: sys.harvestFullHeadEveryDays ?? null,
        harvestDayOfWeek: sys.harvestDayOfWeek || '',
        plantingStartDate: sys.plantingStartDate || '',
        plantEveryXDays: sys.plantEveryXDays ?? null,
        dripFlowRateMlPerMin: sys.dripFlowRateMlPerMin ?? null,
        locationName: sys.location_name || '',
        seedTypeName: sys.seed_name || matchedSeed?.name || '',
        seedType: matchedSeed || undefined,
        growStages: sysStages,
        stations: sysStations,
        updatedAt: sys.updatedAt,
      });
    }
  }

  return {
    seeds: cleanSeeds,
    systems: assembledSystems,
    sourceLabel: `Cloud Firestore (${firebaseProjectId})`,
    isLive: true,
  };
}

async function fetchFromGitHub() {
  const { ghOwner, ghRepo, ghBranch } = state.settings;
  const t = Date.now();
  const baseUrl = `https://raw.githubusercontent.com/${encodeURIComponent(ghOwner)}/${encodeURIComponent(ghRepo)}/${encodeURIComponent(ghBranch)}`;

  const [seedRes, sysRes] = await Promise.all([
    fetch(`${baseUrl}/seed-catalog.json?t=${t}`),
    fetch(`${baseUrl}/system-catalog.json?t=${t}`),
  ]);

  if (!seedRes.ok && !sysRes.ok) {
    throw new Error(`GitHub catalog files not found at ${ghOwner}/${ghRepo}@${ghBranch}`);
  }

  let seeds = [];
  let systems = [];

  if (seedRes.ok) {
    const parsed = await seedRes.json();
    seeds = Array.isArray(parsed) ? parsed : parsed.seedTypes || [];
  }
  if (sysRes.ok) {
    const parsed = await sysRes.json();
    systems = Array.isArray(parsed) ? parsed : parsed.systems || [];
  }

  return {
    seeds,
    systems,
    sourceLabel: `GitHub (${ghOwner}/${ghRepo})`,
    isLive: true,
  };
}

async function fetchFromLocalSnapshot() {
  try {
    const [seedRes, sysRes] = await Promise.all([
      fetch('./seed-catalog.json', { cache: 'no-store' }),
      fetch('./system-catalog.json', { cache: 'no-store' }),
    ]);
    if (seedRes.ok || sysRes.ok) {
      const seedData = seedRes.ok ? await seedRes.json() : {};
      const sysData = sysRes.ok ? await sysRes.json() : {};
      return {
        seeds: Array.isArray(seedData) ? seedData : seedData.seedTypes || [],
        systems: Array.isArray(sysData) ? sysData : sysData.systems || [],
        sourceLabel: 'Local Catalog JSON',
        isLive: false,
      };
    }
  } catch {
    // When opened via file:// protocol, fetch('./seed-catalog.json') is blocked by browser CORS;
    // use window.__LMDB_CATALOG_FALLBACK__ loaded via <script src="./catalog-fallback.js">
  }

  if (window.__LMDB_CATALOG_FALLBACK__) {
    return {
      seeds: window.__LMDB_CATALOG_FALLBACK__.seeds || [],
      systems: window.__LMDB_CATALOG_FALLBACK__.systems || [],
      sourceLabel: 'Bundled Catalog Snapshot',
      isLive: false,
    };
  }

  return { seeds: [], systems: [], sourceLabel: 'Empty Catalog', isLive: false };
}

async function loadAllCatalogData() {
  const badge = document.getElementById('connectionBadge');
  const connText = document.getElementById('connectionText');
  badge.className = 'conn-badge conn-loading';
  connText.textContent = 'Syncing Catalog...';

  const mode = state.settings.sourceMode;
  let result = null;

  try {
    if (mode === 'firestore') {
      result = await fetchFromFirestore();
    } else if (mode === 'github') {
      result = await fetchFromGitHub();
    } else if (mode === 'local') {
      result = await fetchFromLocalSnapshot();
    } else {
      // Auto mode: Firestore -> Local Snapshot -> GitHub
      try {
        result = await fetchFromFirestore();
      } catch (firestoreErr) {
        console.warn('Firestore auto-fetch failed, falling back to local snapshot:', firestoreErr);
        result = await fetchFromLocalSnapshot();
      }
    }
  } catch (err) {
    console.warn('Primary source failed, using local fallback:', err);
    showStatusBanner(`⚠️ Could not reach primary source (${err.message}). Loaded local catalog snapshot.`);
    result = await fetchFromLocalSnapshot();
  }

  // Also ensure any seed types embedded inside system profiles are available in seeds list
  const seedsList = [...(result.seeds || [])];
  for (const sys of result.systems || []) {
    if (sys.seedType && sys.seedType.name) {
      const exists = seedsList.some(
        (s) => (s.name || '').trim().toLowerCase() === sys.seedType.name.trim().toLowerCase(),
      );
      if (!exists) {
        seedsList.push(sys.seedType);
      }
    }
  }

  state.seeds = seedsList;
  state.systems = result.systems || [];
  state.connectionSource = result.sourceLabel;
  state.lastSyncedAt = new Date();

  badge.className = `conn-badge ${result.isLive ? 'conn-live' : 'conn-fallback'}`;
  connText.textContent = result.sourceLabel;
  document.getElementById('footerSyncInfo').textContent =
    `Source: ${result.sourceLabel} • Last updated ${state.lastSyncedAt.toLocaleTimeString()}`;

  renderAll();
}

function showStatusBanner(msg) {
  const el = document.getElementById('statusBanner');
  if (!msg) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = `<span>${escapeHtml(msg)}</span><button class="btn btn-sm btn-secondary" onclick="document.getElementById('statusBanner').hidden=true">Dismiss</button>`;
}

// ─── Rendering Functions ─────────────────────────────────────────────────────

function renderAll() {
  renderStatsBar();
  renderSeedCategoryChips();
  renderSeedsGrid();
  renderSystemTypeChips();
  renderSystemsGrid();
  renderCompareMatrices();
}

function renderStatsBar() {
  document.getElementById('statSeedCount').textContent = state.seeds.length;
  document.getElementById('tabCountSeeds').textContent = state.seeds.length;

  const cropTypes = new Set();
  for (const s of state.seeds) {
    if (s.type && s.type.trim()) cropTypes.add(s.type.trim());
  }
  document.getElementById('statCropTypes').textContent = cropTypes.size;

  document.getElementById('statSystemCount').textContent = state.systems.length;
  document.getElementById('tabCountSystems').textContent = state.systems.length;

  let totalStations = 0;
  let totalChannels = 0;
  for (const sys of state.systems) {
    const sts = sys.stations || [];
    totalStations += sts.length;
    for (const st of sts) {
      totalChannels += (st.channels || []).length;
    }
  }
  document.getElementById('statStationCount').textContent =
    `${totalStations} Stn / ${totalChannels} Ch`;
}

function renderSeedCategoryChips() {
  const wrap = document.getElementById('seedCategoryChips');
  const types = new Set();
  for (const s of state.seeds) {
    const label = (s.type || s.category || 'General').trim();
    if (label) types.add(label);
  }
  const allTypes = ['All', ...Array.from(types).sort()];

  wrap.innerHTML = allTypes
    .map((t) => {
      const count =
        t === 'All'
          ? state.seeds.length
          : state.seeds.filter((s) => (s.type || s.category || 'General').trim() === t).length;
      const active = state.seedCategory === t ? 'active' : '';
      return `<button type="button" class="filter-chip ${active}" data-seed-cat="${escapeHtml(t)}">${escapeHtml(t)} (${count})</button>`;
    })
    .join('');

  wrap.querySelectorAll('[data-seed-cat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.seedCategory = btn.getAttribute('data-seed-cat');
      renderSeedCategoryChips();
      renderSeedsGrid();
    });
  });
}

function getFilteredSeeds() {
  const q = state.seedSearch.trim().toLowerCase();
  const filtered = state.seeds.filter((item) => {
    const itemType = (item.type || item.category || 'General').trim();
    if (state.seedCategory !== 'All' && itemType !== state.seedCategory) return false;
    if (!q) return true;
    const hay = [
      item.name,
      item.type,
      item.category,
      item.brand,
      item.harvestMethod,
      item.plantingInstructions,
      item.harvestingInstructions,
      item.notes,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });

  filtered.sort((a, b) => {
    switch (state.seedSort) {
      case 'name_desc':
        return (b.name || '').localeCompare(a.name || '');
      case 'harvest_asc':
        return (a.daysToHarvest || 999) - (b.daysToHarvest || 999);
      case 'harvest_desc':
        return (b.daysToHarvest || 0) - (a.daysToHarvest || 0);
      case 'stages_desc':
        return (b.growStages?.length || 0) - (a.growStages?.length || 0);
      case 'brand_asc':
        return (a.brand || '').localeCompare(b.brand || '');
      case 'name_asc':
      default:
        return (a.name || '').localeCompare(b.name || '');
    }
  });

  return filtered;
}

function renderSeedsGrid() {
  const grid = document.getElementById('seedsGrid');
  const items = getFilteredSeeds();

  if (items.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-emoji">🌱</div>
        <h3>No matching seed varieties found</h3>
        <p style="color:var(--text-muted);margin-top:6px;">Try clearing your search filter or load a seed catalog JSON export.</p>
      </div>`;
    return;
  }

  grid.innerHTML = items
    .map((item, idx) => {
      const stages = item.growStages || [];
      const totalStageDays = stages.reduce((acc, s) => acc + (s.daysInStageMax || s.daysInStageMin || 7), 0) || 1;
      const stageSegments = stages
        .map((s, sIdx) => {
          const d = s.daysInStageMax || s.daysInStageMin || 7;
          const pct = Math.max(8, Math.round((d / totalStageDays) * 100));
          const color = STAGE_COLORS[sIdx % STAGE_COLORS.length];
          return `<div class="mini-stage-seg" style="width:${pct}%;background:${color};" title="${escapeHtml(s.stageName)}: ${s.daysInStageMin}-${s.daysInStageMax}d"></div>`;
        })
        .join('');

      const storageDays = item.daysSeedsLastInStorage ?? item.shelfLifeDays;
      const storageYears = storageDays ? (storageDays / 365).toFixed(1).replace(/\.0$/, '') : null;

      const thumbHtml = item.photoUri
        ? `<img class="seed-thumb" src="${escapeHtml(item.photoUri)}" alt="${escapeHtml(item.name)}" loading="lazy" />`
        : `<div class="seed-thumb">🌱</div>`;

      const usedBySystems = state.systems.filter(
        (sys) => (sys.seedTypeName || sys.seedType?.name || '').trim().toLowerCase() === (item.name || '').trim().toLowerCase(),
      );

      return `
        <article class="catalog-card" data-seed-idx="${idx}">
          <div class="seed-card-top">
            ${thumbHtml}
            <div class="seed-header-info">
              <div class="card-title-row">
                <div>
                  <h3 class="card-title">${escapeHtml(item.name)}</h3>
                  <div class="card-subtitle">${escapeHtml(item.type || 'Hydroponic Crop')}${item.brand ? ` • ${escapeHtml(item.brand)}` : ''}</div>
                </div>
                <span class="badge badge-harvest">⏱️ ${item.daysToHarvest || '—'}d</span>
              </div>
              ${item.category ? `<div class="card-category">${escapeHtml(item.category)}</div>` : ''}
              <div class="badge-row">
                ${item.harvestMethod ? `<span class="badge badge-amber">✂️ ${escapeHtml(item.harvestMethod)}</span>` : ''}
                ${item.seedTypeSpacingCm ? `<span class="badge badge-blue">📏 ${item.seedTypeSpacingCm} cm</span>` : ''}
                ${storageDays ? `<span class="badge">📦 ${storageDays}d (${storageYears}y) shelf</span>` : ''}
              </div>
            </div>
          </div>

          <div class="card-body">
            ${
              item.plantingInstructions
                ? `<p class="card-desc">${escapeHtml(item.plantingInstructions.replace(/[#*]/g, ''))}</p>`
                : `<p class="card-desc" style="color:var(--text-muted);">Click to view complete planting, harvesting, and storage instructions.</p>`
            }

            <div class="mini-timeline">
              <div class="mini-timeline-header">
                <span>🌱 ${stages.length} Grow Stage${stages.length === 1 ? '' : 's'}</span>
                <span>${stages.length > 0 ? stages.map((s) => s.stageName).join(' → ') : 'Standard Lifecycle'}</span>
              </div>
              <div class="mini-timeline-bar">
                ${stageSegments || `<div class="mini-stage-seg" style="width:100%;background:var(--primary);"></div>`}
              </div>
            </div>
          </div>

          <div class="card-footer">
            <span class="card-footer-meta">
              ${usedBySystems.length > 0 ? `🪴 Used in ${usedBySystems.length} system${usedBySystems.length > 1 ? 's' : ''}` : '☁️ Master Seed Profile'}
            </span>
            <span class="btn btn-outline-primary btn-sm">View Profile &amp; Stages ›</span>
          </div>
        </article>`;
    })
    .join('');

  grid.querySelectorAll('[data-seed-idx]').forEach((card) => {
    card.addEventListener('click', () => {
      const idx = Number(card.getAttribute('data-seed-idx'));
      openSeedDetailModal(items[idx]);
    });
  });
}

function renderSystemTypeChips() {
  const wrap = document.getElementById('systemTypeChips');
  const types = new Set();
  for (const sys of state.systems) {
    if (sys.type) types.add(sys.type.trim());
  }
  const allTypes = ['All', ...Array.from(types).sort()];

  wrap.innerHTML = allTypes
    .map((t) => {
      const count =
        t === 'All' ? state.systems.length : state.systems.filter((s) => (s.type || '').trim() === t).length;
      const active = state.systemType === t ? 'active' : '';
      return `<button type="button" class="filter-chip ${active}" data-sys-type="${escapeHtml(t)}">${escapeHtml(t)} (${count})</button>`;
    })
    .join('');

  wrap.querySelectorAll('[data-sys-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.systemType = btn.getAttribute('data-sys-type');
      renderSystemTypeChips();
      renderSystemsGrid();
    });
  });
}

function getSystemHardwareCounts(sys) {
  const stations = sys.stations || [];
  let channels = 0;
  let plugs = 0;
  let tanks = 0;
  let lights = 0;
  let pumps = 0;
  let totalWattage = 0;

  for (const st of stations) {
    const chs = st.channels || [];
    channels += chs.length;
    for (const c of chs) plugs += c.plugCapacity || 0;
    tanks += (st.tanks || []).length;
    const gls = st.growLights || [];
    lights += gls.length;
    for (const l of gls) totalWattage += l.wattage || 0;
    pumps += (st.pumps || []).length;
  }

  return {
    stationCount: stations.length,
    channels,
    plugs,
    tanks,
    lights,
    pumps,
    totalWattage,
    stageCount: (sys.growStages || []).length,
  };
}

function getFilteredSystems() {
  const q = state.systemSearch.trim().toLowerCase();
  const filtered = state.systems.filter((sys) => {
    if (state.systemType !== 'All' && (sys.type || '').trim() !== state.systemType) return false;
    if (!q) return true;
    const stationNames = (sys.stations || []).map((s) => `${s.name} ${s.purpose || ''}`).join(' ');
    const hay = [
      sys.name,
      sys.type,
      sys.farmerObjective,
      sys.seedTypeName,
      sys.seedType?.name,
      sys.harvestType,
      sys.locationName,
      stationNames,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });

  filtered.sort((a, b) => {
    const hwA = getSystemHardwareCounts(a);
    const hwB = getSystemHardwareCounts(b);
    switch (state.systemSort) {
      case 'stations_desc':
        return hwB.stationCount - hwA.stationCount;
      case 'capacity_desc':
        return hwB.plugs - hwA.plugs;
      case 'stages_desc':
        return hwB.stageCount - hwA.stageCount;
      case 'name_asc':
      default:
        return (a.name || '').localeCompare(b.name || '');
    }
  });

  return filtered;
}

function renderSystemsGrid() {
  const grid = document.getElementById('systemsGrid');
  const items = getFilteredSystems();

  if (items.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <div class="empty-emoji">🪴</div>
        <h3>No matching hydroponic system profiles found</h3>
        <p style="color:var(--text-muted);margin-top:6px;">Try clearing your search filter or enable active farm systems in Data Source settings.</p>
      </div>`;
    return;
  }

  grid.innerHTML = items
    .map((sys, idx) => {
      const hw = getSystemHardwareCounts(sys);
      const linkedSeed =
        sys.seedType ||
        state.seeds.find(
          (s) => (s.name || '').trim().toLowerCase() === (sys.seedTypeName || '').trim().toLowerCase(),
        );

      const thumbHtml = linkedSeed?.photoUri
        ? `<img class="seed-thumb" src="${escapeHtml(linkedSeed.photoUri)}" alt="${escapeHtml(sys.name)}" loading="lazy" />`
        : `<div class="seed-thumb">🪴</div>`;

      const cadenceParts = [];
      if (sys.plantEveryXDays) cadenceParts.push(`Plant every ${sys.plantEveryXDays}d`);
      if (sys.harvestFullHeadCount && sys.harvestFullHeadEveryDays) {
        cadenceParts.push(`Target: ${sys.harvestFullHeadCount} every ${sys.harvestFullHeadEveryDays}d`);
      }
      if (sys.harvestDayOfWeek) cadenceParts.push(`Harvest day: ${sys.harvestDayOfWeek}`);

      return `
        <article class="catalog-card" data-sys-idx="${idx}">
          <div class="seed-card-top">
            ${thumbHtml}
            <div class="seed-header-info">
              <div class="card-title-row">
                <div>
                  <h3 class="card-title">${escapeHtml(sys.name)}</h3>
                  <div class="card-subtitle">
                    ${escapeHtml(sys.type || 'NFT')} System
                    ${sys.seedTypeName ? ` • 🌱 ${escapeHtml(sys.seedTypeName)}` : ''}
                  </div>
                </div>
                <span class="badge badge-harvest">${escapeHtml(sys.harvestType || 'Full Head')}</span>
              </div>
              <div class="badge-row">
                ${
                  sys.sourceType === 'active_farm_system'
                    ? `<span class="badge badge-blue">🏡 Active Farm System</span>`
                    : `<span class="badge badge-purple">☁️ Cloud Catalog Template</span>`
                }
                ${sys.locationName ? `<span class="badge">📍 ${escapeHtml(sys.locationName)}</span>` : ''}
                ${cadenceParts.length > 0 ? `<span class="badge badge-amber">📅 ${escapeHtml(cadenceParts.join(' • '))}</span>` : ''}
              </div>
            </div>
          </div>

          <div class="card-body">
            ${
              sys.farmerObjective
                ? `
              <div class="objective-box">
                <div class="objective-label">🎯 Farmer's Objective</div>
                <div class="objective-text">"${escapeHtml(sys.farmerObjective)}"</div>
              </div>`
                : ''
            }

            <div class="hw-summary-grid">
              <div class="hw-pill">📍 ${hw.stationCount} Station${hw.stationCount === 1 ? '' : 's'}</div>
              <div class="hw-pill">📺 ${hw.channels} Ch (${hw.plugs} plugs)</div>
              <div class="hw-pill">🧪 ${hw.tanks} Tank${hw.tanks === 1 ? '' : 's'}</div>
              <div class="hw-pill">💡 ${hw.lights} Light${hw.lights === 1 ? '' : 's'}</div>
              <div class="hw-pill">⚙️ ${hw.pumps} Pump${hw.pumps === 1 ? '' : 's'}</div>
              <div class="hw-pill">🌱 ${hw.stageCount} Stage${hw.stageCount === 1 ? '' : 's'}</div>
            </div>
          </div>

          <div class="card-footer">
            <span class="card-footer-meta">
              ${(sys.stations || []).map((s) => s.name).join(' → ') || 'Complete System Profile'}
            </span>
            <span class="btn btn-outline-primary btn-sm">🔍 Architecture &amp; Hardware ›</span>
          </div>
        </article>`;
    })
    .join('');

  grid.querySelectorAll('[data-sys-idx]').forEach((card) => {
    card.addEventListener('click', () => {
      const idx = Number(card.getAttribute('data-sys-idx'));
      openSystemDetailModal(items[idx]);
    });
  });
}

function renderCompareMatrices() {
  const seedsWrap = document.getElementById('compareSeedsTableWrap');
  const sysWrap = document.getElementById('compareSystemsTableWrap');

  if (state.seeds.length === 0) {
    seedsWrap.innerHTML = `<div style="padding:20px;color:var(--text-muted);">No seed varieties loaded.</div>`;
  } else {
    seedsWrap.innerHTML = `
      <table class="compare-table">
        <thead>
          <tr>
            <th>Variety Name</th>
            <th>Crop Type</th>
            <th>Category</th>
            <th>Brand</th>
            <th>Days to Harvest</th>
            <th>Spacing</th>
            <th>Seed Shelf Life</th>
            <th>Harvest Method</th>
            <th>Grow Stages</th>
          </tr>
        </thead>
        <tbody>
          ${state.seeds
            .map((s, idx) => {
              const shelf = s.daysSeedsLastInStorage ?? s.shelfLifeDays;
              return `
                <tr data-cmp-seed="${idx}">
                  <td><strong>${escapeHtml(s.name)}</strong></td>
                  <td><span class="badge">${escapeHtml(s.type || '—')}</span></td>
                  <td style="color:var(--text-muted);">${escapeHtml(s.category || '—')}</td>
                  <td>${escapeHtml(s.brand || '—')}</td>
                  <td><span class="badge badge-harvest">${s.daysToHarvest || '—'} days</span></td>
                  <td>${s.seedTypeSpacingCm ? `${s.seedTypeSpacingCm} cm` : '—'}</td>
                  <td>${shelf ? `${shelf} days` : '—'}</td>
                  <td>${escapeHtml(s.harvestMethod || '—')}</td>
                  <td>${(s.growStages || []).length} stages</td>
                </tr>`;
            })
            .join('')}
        </tbody>
      </table>`;

    seedsWrap.querySelectorAll('[data-cmp-seed]').forEach((row) => {
      row.addEventListener('click', () => {
        const idx = Number(row.getAttribute('data-cmp-seed'));
        openSeedDetailModal(state.seeds[idx]);
      });
    });
  }

  if (state.systems.length === 0) {
    sysWrap.innerHTML = `<div style="padding:20px;color:var(--text-muted);">No hydroponic systems loaded.</div>`;
  } else {
    sysWrap.innerHTML = `
      <table class="compare-table">
        <thead>
          <tr>
            <th>System Name</th>
            <th>Type</th>
            <th>Target Seed Variety</th>
            <th>Harvest Mode</th>
            <th>Planting Cadence</th>
            <th>Stations</th>
            <th>Channels &amp; Plugs</th>
            <th>Tanks</th>
            <th>Grow Lights &amp; Pumps</th>
          </tr>
        </thead>
        <tbody>
          ${state.systems
            .map((sys, idx) => {
              const hw = getSystemHardwareCounts(sys);
              return `
                <tr data-cmp-sys="${idx}">
                  <td><strong>${escapeHtml(sys.name)}</strong></td>
                  <td><span class="badge badge-harvest">${escapeHtml(sys.type || 'NFT')}</span></td>
                  <td>${escapeHtml(sys.seedTypeName || sys.seedType?.name || '—')}</td>
                  <td>${escapeHtml(sys.harvestType || 'Full Head')}</td>
                  <td>${sys.plantEveryXDays ? `Every ${sys.plantEveryXDays}d` : '—'}${sys.harvestDayOfWeek ? ` (${escapeHtml(sys.harvestDayOfWeek)})` : ''}</td>
                  <td>${hw.stationCount} (${(sys.stations || []).map((s) => escapeHtml(s.name)).join(', ')})</td>
                  <td>${hw.channels} ch / <strong>${hw.plugs} plugs</strong></td>
                  <td>${hw.tanks} tanks</td>
                  <td>${hw.lights} lights / ${hw.pumps} pumps</td>
                </tr>`;
            })
            .join('')}
        </tbody>
      </table>`;

    sysWrap.querySelectorAll('[data-cmp-sys]').forEach((row) => {
      row.addEventListener('click', () => {
        const idx = Number(row.getAttribute('data-cmp-sys'));
        openSystemDetailModal(state.systems[idx]);
      });
    });
  }
}

// ─── Detail Modal: Seed Profile ──────────────────────────────────────────────

function openSeedDetailModal(seed) {
  if (!seed) return;
  state.activeModalItem = { kind: 'seed', data: seed };

  const backdrop = document.getElementById('detailModalBackdrop');
  const badgesEl = document.getElementById('detailModalBadges');
  const titleEl = document.getElementById('detailModalTitle');
  const subEl = document.getElementById('detailModalSubtitle');
  const bodyEl = document.getElementById('detailModalBody');

  badgesEl.innerHTML = `
    <span class="badge badge-harvest">🌱 Seed Variety Profile</span>
    ${seed.type ? `<span class="badge">${escapeHtml(seed.type)}</span>` : ''}
    ${seed.brand ? `<span class="badge badge-blue">🏷️ ${escapeHtml(seed.brand)}</span>` : ''}
    ${seed.catalogId ? `<span class="badge">ID: ${escapeHtml(seed.catalogId)}</span>` : ''}
  `;
  titleEl.textContent = seed.name;
  subEl.textContent = seed.category || `${seed.type || 'Hydroponic'} Cultivar`;

  const storageDays = seed.daysSeedsLastInStorage ?? seed.shelfLifeDays;
  const stages = seed.growStages || [];

  const harvestMethods = (seed.harvestMethod || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  const parsedHarvestInstructions = parseHarvestingInstructions(
    seed.harvestingInstructions || '',
    harvestMethods,
  );

  const matchingSystems = state.systems.filter(
    (sys) =>
      (sys.seedTypeName || sys.seedType?.name || '').trim().toLowerCase() ===
      (seed.name || '').trim().toLowerCase(),
  );

  const photoHtml = seed.photoUri
    ? `<img class="detail-photo" src="${escapeHtml(seed.photoUri)}" alt="${escapeHtml(seed.name)}" />`
    : `<div class="detail-photo">🌱</div>`;

  bodyEl.innerHTML = `
    <div class="detail-hero">
      ${photoHtml}
      <div class="detail-metrics-grid">
        <div class="metric-box">
          <div class="metric-box-label">⏱️ Days to Harvest</div>
          <div class="metric-box-val">${seed.daysToHarvest ? `${seed.daysToHarvest} Days` : 'N/A'}</div>
        </div>
        <div class="metric-box">
          <div class="metric-box-label">📏 Plant Spacing</div>
          <div class="metric-box-val">${seed.seedTypeSpacingCm ? `${seed.seedTypeSpacingCm} cm` : 'Standard'}</div>
        </div>
        <div class="metric-box">
          <div class="metric-box-label">📦 Seed Storage Life</div>
          <div class="metric-box-val">${storageDays ? `${storageDays} Days (~${(storageDays / 365).toFixed(1)} yr)` : 'N/A'}</div>
        </div>
        <div class="metric-box">
          <div class="metric-box-label">✂️ Harvest Method</div>
          <div class="metric-box-val" style="font-size:13px;">${escapeHtml(seed.harvestMethod || 'Standard')}</div>
        </div>
        <div class="metric-box">
          <div class="metric-box-label">🌱 Defined Grow Stages</div>
          <div class="metric-box-val">${stages.length} Stage${stages.length === 1 ? '' : 's'}</div>
        </div>
        <div class="metric-box">
          <div class="metric-box-label">🏷️ Supplier / Brand</div>
          <div class="metric-box-val">${escapeHtml(seed.brand || 'Generic')}</div>
        </div>
      </div>
    </div>

    ${
      matchingSystems.length > 0
        ? `
      <div class="detail-section">
        <h3 class="detail-section-title">🪴 Hydroponic Systems Configured for ${escapeHtml(seed.name)}</h3>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          ${matchingSystems
            .map(
              (sys) => `
            <button type="button" class="btn btn-outline-primary" data-jump-system="${escapeHtml(sys.name)}">
              🪴 Open System: ${escapeHtml(sys.name)} (${escapeHtml(sys.type || 'NFT')}) ›
            </button>`,
            )
            .join('')}
        </div>
      </div>`
        : ''
    }

    <div class="detail-section">
      <h3 class="detail-section-title">📊 Grow Stages Lifecycle (${stages.length})</h3>
      ${
        stages.length === 0
          ? `<p style="color:var(--text-muted);font-size:13px;">No stage-by-stage breakdown defined for this variety.</p>`
          : `
        <div class="stages-list">
          ${stages
            .map((stg, idx) => {
              const daysLabel =
                stg.daysInStageMin === stg.daysInStageMax
                  ? `${stg.daysInStageMin} days`
                  : `${stg.daysInStageMin} – ${stg.daysInStageMax} days`;
              const longDesc = stg.stageDescriptionLong || stg.stageDescription || '';
              const shortDesc = stg.stageDescriptionShort || '';
              return `
                <div class="stage-card">
                  <div class="stage-card-header">
                    <div>
                      <span class="stage-index-badge">${idx + 1}</span>
                      <span class="stage-name">${escapeHtml(stg.stageName)}</span>
                    </div>
                    <span class="badge badge-harvest">⏱️ ${escapeHtml(daysLabel)}</span>
                  </div>
                  ${shortDesc && shortDesc !== longDesc ? `<div class="stage-desc-short">${escapeHtml(shortDesc)}</div>` : ''}
                  ${longDesc ? `<div class="stage-desc-long">${formatSimpleMarkdown(longDesc)}</div>` : ''}
                </div>`;
            })
            .join('')}
        </div>`
      }
    </div>

    ${
      seed.plantingInstructions
        ? `
      <div class="detail-section">
        <h3 class="detail-section-title">🌱 Planting &amp; Germination Instructions</h3>
        <div class="instruction-block">${formatSimpleMarkdown(seed.plantingInstructions)}</div>
      </div>`
        : ''
    }

    ${
      seed.harvestingInstructions
        ? `
      <div class="detail-section">
        <h3 class="detail-section-title">✂️ Harvesting Instructions</h3>
        ${Object.entries(parsedHarvestInstructions)
          .map(
            ([method, content]) => `
          <div class="method-subcard">
            ${method !== 'General' ? `<div class="method-subcard-title">✂️ ${escapeHtml(method)}</div>` : ''}
            <div class="instruction-block">${formatSimpleMarkdown(content)}</div>
          </div>`,
          )
          .join('')}
      </div>`
        : ''
    }

    ${
      seed.harvestedStorageInstructions
        ? `
      <div class="detail-section">
        <h3 class="detail-section-title">❄️ Post-Harvest Produce Storage Instructions</h3>
        <div class="instruction-block">${formatSimpleMarkdown(seed.harvestedStorageInstructions)}</div>
      </div>`
        : ''
    }

    ${
      seed.notes
        ? `
      <div class="detail-section">
        <h3 class="detail-section-title">📝 Variety Notes</h3>
        <div class="instruction-block">${formatSimpleMarkdown(seed.notes)}</div>
      </div>`
        : ''
    }
  `;

  bodyEl.querySelectorAll('[data-jump-system]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sysName = btn.getAttribute('data-jump-system');
      const target = state.systems.find((s) => s.name === sysName);
      if (target) openSystemDetailModal(target);
    });
  });

  backdrop.hidden = false;
}

// ─── Detail Modal: System Profile ────────────────────────────────────────────

function openSystemDetailModal(sys) {
  if (!sys) return;
  state.activeModalItem = { kind: 'system', data: sys };

  const backdrop = document.getElementById('detailModalBackdrop');
  const badgesEl = document.getElementById('detailModalBadges');
  const titleEl = document.getElementById('detailModalTitle');
  const subEl = document.getElementById('detailModalSubtitle');
  const bodyEl = document.getElementById('detailModalBody');

  const hw = getSystemHardwareCounts(sys);
  const linkedSeed =
    sys.seedType ||
    state.seeds.find(
      (s) => (s.name || '').trim().toLowerCase() === (sys.seedTypeName || '').trim().toLowerCase(),
    );

  badgesEl.innerHTML = `
    <span class="badge badge-harvest">🪴 ${escapeHtml(sys.type || 'NFT')} Hydroponic System</span>
    <span class="badge badge-amber">✂️ ${escapeHtml(sys.harvestType || 'Full Head')}</span>
    ${sys.locationName ? `<span class="badge badge-blue">📍 ${escapeHtml(sys.locationName)}</span>` : ''}
    ${sys.catalogId ? `<span class="badge">ID: ${escapeHtml(sys.catalogId)}</span>` : ''}
  `;
  titleEl.textContent = sys.name;
  subEl.textContent = sys.seedTypeName
    ? `Optimized for ${sys.seedTypeName} • ${hw.stationCount} Stations, ${hw.channels} Channels (${hw.plugs} Total Plugs)`
    : `${hw.stationCount} Stations, ${hw.channels} Channels (${hw.plugs} Total Plugs)`;

  const stations = sys.stations || [];
  const stages = sys.growStages || [];

  bodyEl.innerHTML = `
    ${
      sys.farmerObjective
        ? `
      <div class="objective-box" style="padding:14px 18px;">
        <div class="objective-label">🎯 Farmer's Objective</div>
        <div class="objective-text" style="font-size:15px;">"${escapeHtml(sys.farmerObjective)}"</div>
      </div>`
        : ''
    }

    <div class="detail-metrics-grid">
      <div class="metric-box">
        <div class="metric-box-label">🌱 Target Seed Variety</div>
        <div class="metric-box-val" style="font-size:14px;">
          ${escapeHtml(sys.seedTypeName || linkedSeed?.name || 'Multi-Crop')}
        </div>
      </div>
      <div class="metric-box">
        <div class="metric-box-label">📅 Planting Cadence</div>
        <div class="metric-box-val" style="font-size:14px;">
          ${sys.plantEveryXDays ? `Every ${sys.plantEveryXDays} Days` : 'On-Demand'}
        </div>
      </div>
      <div class="metric-box">
        <div class="metric-box-label">🧺 Harvest Target</div>
        <div class="metric-box-val" style="font-size:14px;">
          ${
            sys.harvestFullHeadCount && sys.harvestFullHeadEveryDays
              ? `${sys.harvestFullHeadCount} / ${sys.harvestFullHeadEveryDays}d`
              : escapeHtml(sys.harvestType || 'Full Head')
          }
          ${sys.harvestDayOfWeek ? ` (${escapeHtml(sys.harvestDayOfWeek)})` : ''}
        </div>
      </div>
      <div class="metric-box">
        <div class="metric-box-label">📺 Total Plug Capacity</div>
        <div class="metric-box-val">${hw.plugs} Plugs (${hw.channels} Ch)</div>
      </div>
      <div class="metric-box">
        <div class="metric-box-label">🧪 Nutrient Tanks</div>
        <div class="metric-box-val">${hw.tanks} Reservoir${hw.tanks === 1 ? '' : 's'}</div>
      </div>
      <div class="metric-box">
        <div class="metric-box-label">💡 Lighting &amp; Pumps</div>
        <div class="metric-box-val">${hw.lights} Light${hw.lights === 1 ? '' : 's'} / ${hw.pumps} Pump${hw.pumps === 1 ? '' : 's'}</div>
      </div>
    </div>

    ${
      linkedSeed
        ? `
      <div class="detail-section" style="display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;">
        <div style="display:flex;align-items:center;gap:14px;">
          ${
            linkedSeed.photoUri
              ? `<img src="${escapeHtml(linkedSeed.photoUri)}" alt="${escapeHtml(linkedSeed.name)}" style="width:54px;height:54px;border-radius:10px;object-fit:cover;border:1px solid var(--border);" />`
              : `<div style="font-size:28px;">🌱</div>`
          }
          <div>
            <div style="font-size:12px;color:var(--primary);font-weight:700;text-transform:uppercase;">Required Seed Variety Pre-Requisite</div>
            <div style="font-size:16px;font-weight:800;">${escapeHtml(linkedSeed.name)} (${escapeHtml(linkedSeed.type || 'Crop')})</div>
            <div style="font-size:12px;color:var(--text-muted);">
              ${linkedSeed.daysToHarvest ? `${linkedSeed.daysToHarvest} days to harvest` : ''}
              ${linkedSeed.seedTypeSpacingCm ? ` • ${linkedSeed.seedTypeSpacingCm} cm spacing` : ''}
              ${linkedSeed.brand ? ` • ${escapeHtml(linkedSeed.brand)}` : ''}
            </div>
          </div>
        </div>
        <button type="button" class="btn btn-outline-primary btn-sm" id="btnOpenLinkedSeed">
          🌱 View Full Seed Profile ›
        </button>
      </div>`
        : ''
    }

    <!-- STATIONS & HARDWARE LAYOUT -->
    <div class="detail-section">
      <h3 class="detail-section-title">📍 Stations &amp; Hardware Architecture (${stations.length})</h3>
      ${
        stations.length === 0
          ? `<p style="color:var(--text-muted);font-size:13px;">No stations configured in this system profile.</p>`
          : stations
              .map((st, sIdx) => {
                const channels = st.channels || [];
                const tanks = st.tanks || [];
                const lights = st.growLights || [];
                const pumps = st.pumps || [];
                const stPlugs = channels.reduce((acc, c) => acc + (c.plugCapacity || 0), 0);

                return `
                  <div class="station-card">
                    <div class="station-header">
                      <div>
                        <div class="station-title">
                          <span class="stage-index-badge">${sIdx + 1}</span>
                          ${escapeHtml(st.name)}
                        </div>
                        ${st.purpose ? `<div class="station-purpose">${escapeHtml(st.purpose)}</div>` : ''}
                      </div>
                      <div class="badge-row" style="margin-top:0;">
                        <span class="badge badge-harvest">${escapeHtml(st.type || sys.type || 'NFT')}</span>
                        <span class="badge">${escapeHtml(st.containerType || 'Grow Plug')}</span>
                        ${st.transplantRequired ? `<span class="badge badge-amber">🔄 Transplant Required</span>` : ''}
                        ${st.desiredPh != null ? `<span class="badge badge-blue">pH ${st.desiredPh}</span>` : ''}
                        ${st.desiredEc != null ? `<span class="badge badge-purple">EC ${st.desiredEc}</span>` : ''}
                      </div>
                    </div>

                    <div class="station-subgrid">
                      <!-- Channels -->
                      <div class="hw-group-box">
                        <div class="hw-group-title">
                          <span>📺 Channels (${channels.length})</span>
                          <span class="badge">${stPlugs} Total Plugs</span>
                        </div>
                        ${
                          channels.length === 0
                            ? `<div style="font-size:12px;color:var(--text-muted);">No channels defined.</div>`
                            : channels
                                .map((ch) => {
                                  const dotCount = Math.min(ch.plugCapacity || 0, 24);
                                  const dots = Array.from({ length: dotCount })
                                    .map(() => `<span class="plug-dot"></span>`)
                                    .join('');
                                  return `
                                    <div class="hw-item-row">
                                      <div class="hw-item-name">
                                        <span>Channel #${escapeHtml(ch.label)}</span>
                                        <span class="badge badge-harvest">${ch.plugCapacity || 0} plugs</span>
                                      </div>
                                      <div class="hw-item-meta">
                                        ${ch.lengthCm ? `<span>📏 ${ch.lengthCm} cm</span>` : ''}
                                        ${ch.seedTypeSpacingCm ? `<span>↔️ ${ch.seedTypeSpacingCm} cm spacing</span>` : ''}
                                        ${ch.withDome ? `<span>⛺ Dome</span>` : ''}
                                        ${ch.withHeat ? `<span>🔥 Heat Mat</span>` : ''}
                                        ${ch.withWatering ? `<span>💧 Watering</span>` : ''}
                                      </div>
                                      ${dotCount > 0 ? `<div class="plug-strip-dots" title="${ch.plugCapacity} plug sites">${dots}</div>` : ''}
                                    </div>`;
                                })
                                .join('')
                        }
                      </div>

                      <!-- Tanks -->
                      <div class="hw-group-box">
                        <div class="hw-group-title">
                          <span>🧪 Nutrient &amp; Water Tanks (${tanks.length})</span>
                        </div>
                        ${
                          tanks.length === 0
                            ? `<div style="font-size:12px;color:var(--text-muted);">No tanks defined.</div>`
                            : tanks
                                .map(
                                  (tk) => `
                                  <div class="hw-item-row">
                                    <div class="hw-item-name">
                                      <span>${escapeHtml(tk.name)}</span>
                                      <span class="badge">${escapeHtml(tk.type || 'Nutrient')}</span>
                                    </div>
                                    <div class="hw-item-meta">
                                      ${tk.volumeLiters != null ? `<span>🪣 ${tk.volumeLiters} L</span>` : ''}
                                      ${tk.desiredPh != null ? `<span>🎯 pH ${tk.desiredPh}</span>` : ''}
                                      ${tk.desiredEc != null ? `<span>⚡ EC ${tk.desiredEc} mS/cm</span>` : ''}
                                      ${tk.desiredNutrientSolutionMl != null ? `<span>🧴 ${tk.desiredNutrientSolutionMl} mL dose</span>` : ''}
                                    </div>
                                    ${
                                      tk.tankFillingInstructions
                                        ? `
                                      <details class="tank-instructions">
                                        <summary>View Tank Filling Recipe</summary>
                                        <div class="details-content">${formatSimpleMarkdown(tk.tankFillingInstructions)}</div>
                                      </details>`
                                        : ''
                                    }
                                  </div>`,
                                )
                                .join('')
                        }
                      </div>

                      <!-- Grow Lights & Pumps -->
                      <div class="hw-group-box">
                        <div class="hw-group-title">
                          <span>💡 Grow Lights (${lights.length}) &amp; ⚙️ Pumps (${pumps.length})</span>
                        </div>
                        ${
                          lights.length === 0 && pumps.length === 0
                            ? `<div style="font-size:12px;color:var(--text-muted);">No lights or pumps defined.</div>`
                            : ''
                        }
                        ${lights
                          .map(
                            (gl) => `
                            <div class="hw-item-row">
                              <div class="hw-item-name">
                                <span>💡 ${escapeHtml(gl.name)}</span>
                                ${gl.dimmerPercent != null ? `<span class="badge badge-amber">🔆 ${gl.dimmerPercent}%</span>` : ''}
                              </div>
                              <div class="hw-item-meta">
                                ${gl.brandModel ? `<span>${escapeHtml(gl.brandModel)}</span>` : ''}
                                ${gl.wattage ? `<span>⚡ ${gl.wattage}W</span>` : ''}
                                ${gl.spectrumType ? `<span>🌈 ${escapeHtml(gl.spectrumType)}</span>` : ''}
                                ${gl.lightHours ? `<span>☀️ ${gl.lightHours}h/day</span>` : ''}
                                ${gl.onTime && gl.offTime ? `<span>🕒 ${escapeHtml(gl.onTime)}–${escapeHtml(gl.offTime)}</span>` : ''}
                              </div>
                            </div>`,
                          )
                          .join('')}
                        ${pumps
                          .map(
                            (pm) => `
                            <div class="hw-item-row">
                              <div class="hw-item-name">
                                <span>⚙️ ${escapeHtml(pm.name)}</span>
                                <span class="badge badge-blue">${escapeHtml(pm.scheduleMode || 'always_on')}</span>
                              </div>
                              <div class="hw-item-meta">
                                ${pm.tankName ? `<span>🧪 Tank: ${escapeHtml(pm.tankName)}</span>` : ''}
                                ${
                                  pm.runDurationValue && pm.cycleIntervalValue
                                    ? `<span>🔄 ${pm.runDurationValue} ${escapeHtml(pm.runDurationUnit || 'min')} every ${pm.cycleIntervalValue} ${escapeHtml(pm.cycleIntervalUnit || 'min')}</span>`
                                    : ''
                                }
                                ${
                                  pm.connectedChannelLabels && pm.connectedChannelLabels.length > 0
                                    ? `<span>📺 Ch: ${escapeHtml(pm.connectedChannelLabels.join(', '))}</span>`
                                    : ''
                                }
                              </div>
                            </div>`,
                          )
                          .join('')}
                      </div>
                    </div>
                  </div>`;
              })
              .join('')
      }
    </div>

    <!-- SYSTEM GROW STAGES -->
    <div class="detail-section">
      <h3 class="detail-section-title">🌱 System Grow Stages &amp; Irrigation Targets (${stages.length})</h3>
      ${
        stages.length === 0
          ? `<p style="color:var(--text-muted);font-size:13px;">No system grow stages specified.</p>`
          : `
        <div class="stages-list">
          ${stages
            .map((stg, idx) => {
              const daysLabel =
                stg.daysInStageMin === stg.daysInStageMax
                  ? `${stg.daysInStageMin} days`
                  : `${stg.daysInStageMin} – ${stg.daysInStageMax} days`;
              const longDesc = stg.stageDescriptionLong || stg.stageDescription || '';
              const dripShots = stg.dripShots || [];
              const reminders = stg.reminders || [];

              return `
                <div class="stage-card">
                  <div class="stage-card-header">
                    <div>
                      <span class="stage-index-badge">${idx + 1}</span>
                      <span class="stage-name">${escapeHtml(stg.stageName)}</span>
                    </div>
                    <div class="badge-row" style="margin-top:0;">
                      <span class="badge badge-harvest">⏱️ ${escapeHtml(daysLabel)}</span>
                      <span class="badge">${escapeHtml(stg.containerType || 'Grow Plug')}</span>
                      ${stg.transplantRequired ? `<span class="badge badge-amber">🔄 Transplant</span>` : ''}
                      ${stg.desiredPh != null ? `<span class="badge badge-blue">pH ${stg.desiredPh}</span>` : ''}
                      ${stg.desiredEc != null ? `<span class="badge badge-purple">EC ${stg.desiredEc}</span>` : ''}
                      ${
                        stg.targetDripVolumeMinMl || stg.targetDripVolumeMaxMl
                          ? `<span class="badge">💧 Drip: ${stg.targetDripVolumeMinMl || 0}–${stg.targetDripVolumeMaxMl || 0} mL</span>`
                          : ''
                      }
                    </div>
                  </div>
                  ${longDesc ? `<div class="stage-desc-long">${formatSimpleMarkdown(longDesc)}</div>` : ''}
                  ${
                    dripShots.length > 0
                      ? `
                    <div style="margin-top:10px;">
                      <div style="font-size:12px;font-weight:700;color:var(--primary);margin-bottom:4px;">💧 Scheduled Drip Shots (${dripShots.length})</div>
                      <div class="badge-row">
                        ${dripShots
                          .map(
                            (sh) =>
                              `<span class="badge badge-blue">🕒 ${escapeHtml(sh.shotTime)} — ${escapeHtml(sh.shotName || 'Shot')}: ${sh.volumeMl} mL (${sh.durationSeconds}s)</span>`,
                          )
                          .join('')}
                      </div>
                    </div>`
                      : ''
                  }
                  ${
                    reminders.length > 0
                      ? `
                    <div style="margin-top:10px;">
                      <div style="font-size:12px;font-weight:700;color:var(--flowering);margin-bottom:4px;">🔔 Stage Reminders</div>
                      <div class="badge-row">
                        ${reminders
                          .map((r) => `<span class="badge badge-amber">Day ${r.dayInStage}: ${escapeHtml(r.reminder)}</span>`)
                          .join('')}
                      </div>
                    </div>`
                      : ''
                  }
                </div>`;
            })
            .join('')}
        </div>`
      }
    </div>
  `;

  const btnLinkedSeed = document.getElementById('btnOpenLinkedSeed');
  if (btnLinkedSeed && linkedSeed) {
    btnLinkedSeed.addEventListener('click', () => {
      openSeedDetailModal(linkedSeed);
    });
  }

  backdrop.hidden = false;
}

// ─── JSON Download & Upload Helpers ──────────────────────────────────────────

function downloadJsonFile(filename, payloadObj) {
  const jsonStr = JSON.stringify(payloadObj, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportAllSeedsJson() {
  const payload = {
    $schemaVersion: 1,
    version: 1,
    type: 'SeedPackageCatalogExport',
    exportedAt: new Date().toISOString(),
    appName: 'LmdbHydroponics',
    seedTypes: state.seeds,
  };
  downloadJsonFile('seed-catalog.json', payload);
}

function exportAllSystemsJson() {
  const payload = {
    $schemaVersion: 1,
    version: 1,
    type: 'SystemCatalogExport',
    exportedAt: new Date().toISOString(),
    appName: 'LmdbHydroponics',
    systems: state.systems,
  };
  downloadJsonFile('system-catalog.json', payload);
}

function exportActiveModalItemJson() {
  if (!state.activeModalItem) return;
  const { kind, data } = state.activeModalItem;
  const slug = (data.name || 'item')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  if (kind === 'seed') {
    downloadJsonFile(`seed-${slug}.json`, {
      $schemaVersion: 1,
      version: 1,
      type: 'seed_type_export',
      exportedAt: new Date().toISOString(),
      appName: 'LMDB Hydroponics',
      seedTypes: [data],
    });
  } else {
    downloadJsonFile(`system-${slug}.json`, {
      $schemaVersion: 1,
      version: 1,
      type: 'system_catalog_export',
      exportedAt: new Date().toISOString(),
      appName: 'LMDB Hydroponics',
      systems: [data],
    });
  }
}

async function handleJsonFilesUpload(fileList) {
  if (!fileList || fileList.length === 0) return;
  let addedSeeds = 0;
  let addedSystems = 0;

  for (const file of Array.from(fileList)) {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);

      // Check for seed types
      const seedCandidates = Array.isArray(parsed.seedTypes)
        ? parsed.seedTypes
        : parsed.seedType
        ? [parsed.seedType]
        : Array.isArray(parsed) && parsed[0]?.daysToHarvest !== undefined
        ? parsed
        : [];

      for (const s of seedCandidates) {
        if (!s || !s.name) continue;
        const idx = state.seeds.findIndex(
          (x) => (x.name || '').trim().toLowerCase() === s.name.trim().toLowerCase(),
        );
        if (idx >= 0) {
          state.seeds[idx] = s;
        } else {
          state.seeds.push(s);
        }
        addedSeeds++;
      }

      // Check for systems
      const sysCandidates = Array.isArray(parsed.systems)
        ? parsed.systems
        : parsed.system
        ? [parsed.system]
        : Array.isArray(parsed) && parsed[0]?.stations !== undefined
        ? parsed
        : [];

      for (const sys of sysCandidates) {
        if (!sys || !sys.name) continue;
        const idx = state.systems.findIndex(
          (x) => (x.name || '').trim().toLowerCase() === sys.name.trim().toLowerCase(),
        );
        if (idx >= 0) {
          state.systems[idx] = sys;
        } else {
          state.systems.push(sys);
        }
        addedSystems++;
      }
    } catch (e) {
      showStatusBanner(`⚠️ Failed to parse ${file.name}: ${e.message}`);
    }
  }

  renderAll();
  showStatusBanner(
    `✅ Loaded ${addedSeeds} seed variet${addedSeeds === 1 ? 'y' : 'ies'} and ${addedSystems} system profile${addedSystems === 1 ? '' : 's'} from uploaded JSON.`,
  );
}

// ─── Event Wiring & Initialization ───────────────────────────────────────────

function switchTab(tabKey) {
  state.activeTab = tabKey;
  document.querySelectorAll('.tab').forEach((btn) => {
    const isMatch = btn.getAttribute('data-tab') === tabKey;
    btn.classList.toggle('active', isMatch);
    btn.setAttribute('aria-selected', isMatch ? 'true' : 'false');
  });

  document.getElementById('viewSeeds').hidden = tabKey !== 'seeds';
  document.getElementById('viewSystems').hidden = tabKey !== 'systems';
  document.getElementById('viewCompare').hidden = tabKey !== 'compare';
}

function initTheme() {
  const saved = localStorage.getItem(STORAGE_KEY_THEME) || 'dark';
  if (saved === 'light') {
    document.body.classList.add('theme-light');
    document.getElementById('themeIcon').textContent = '🌙';
  } else {
    document.body.classList.remove('theme-light');
    document.getElementById('themeIcon').textContent = '☀️';
  }
}

function toggleTheme() {
  const isLight = document.body.classList.toggle('theme-light');
  localStorage.setItem(STORAGE_KEY_THEME, isLight ? 'light' : 'dark');
  document.getElementById('themeIcon').textContent = isLight ? '🌙' : '☀️';
}

function openSettingsModal() {
  document.getElementById('settingSourceMode').value = state.settings.sourceMode;
  document.getElementById('settingFirebaseProjectId').value = state.settings.firebaseProjectId;
  document.getElementById('settingFirebaseApiKey').value = state.settings.firebaseApiKey;
  document.getElementById('settingIncludeActiveFarm').checked = !!state.settings.includeActiveFarm;
  document.getElementById('settingGhOwner').value = state.settings.ghOwner;
  document.getElementById('settingGhRepo').value = state.settings.ghRepo;
  document.getElementById('settingGhBranch').value = state.settings.ghBranch;
  document.getElementById('settingsModalBackdrop').hidden = false;
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();

  // Tabs
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
  });

  // Stat cards click to switch tab
  document.getElementById('statCardSeeds').addEventListener('click', () => switchTab('seeds'));
  document.getElementById('statCardCategories').addEventListener('click', () => switchTab('seeds'));
  document.getElementById('statCardSystems').addEventListener('click', () => switchTab('systems'));
  document.getElementById('statCardHardware').addEventListener('click', () => switchTab('systems'));

  // Search & Sort Inputs
  document.getElementById('seedSearchInput').addEventListener('input', (e) => {
    state.seedSearch = e.target.value;
    renderSeedsGrid();
  });
  document.getElementById('seedSortSelect').addEventListener('change', (e) => {
    state.seedSort = e.target.value;
    renderSeedsGrid();
  });

  document.getElementById('systemSearchInput').addEventListener('input', (e) => {
    state.systemSearch = e.target.value;
    renderSystemsGrid();
  });
  document.getElementById('systemSortSelect').addEventListener('change', (e) => {
    state.systemSort = e.target.value;
    renderSystemsGrid();
  });

  // Topbar & Export buttons
  document.getElementById('btnRefresh').addEventListener('click', () => loadAllCatalogData());
  document.getElementById('btnThemeToggle').addEventListener('click', toggleTheme);
  document.getElementById('btnExportSeeds').addEventListener('click', exportAllSeedsJson);
  document.getElementById('btnExportSystems').addEventListener('click', exportAllSystemsJson);

  // Upload JSON
  const fileInput = document.getElementById('fileInputJson');
  document.getElementById('btnUploadJson').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    handleJsonFilesUpload(e.target.files);
    fileInput.value = '';
  });

  // Detail Modal events
  const detailBackdrop = document.getElementById('detailModalBackdrop');
  document.getElementById('btnCloseDetailModal').addEventListener('click', () => {
    detailBackdrop.hidden = true;
  });
  document.getElementById('btnDownloadSingleItem').addEventListener('click', exportActiveModalItemJson);
  detailBackdrop.addEventListener('click', (e) => {
    if (e.target === detailBackdrop) detailBackdrop.hidden = true;
  });

  // Settings Modal events
  const settingsBackdrop = document.getElementById('settingsModalBackdrop');
  document.getElementById('btnSourceSettings').addEventListener('click', openSettingsModal);
  document.getElementById('btnCloseSettingsModal').addEventListener('click', () => {
    settingsBackdrop.hidden = true;
  });
  settingsBackdrop.addEventListener('click', (e) => {
    if (e.target === settingsBackdrop) settingsBackdrop.hidden = true;
  });

  document.getElementById('btnResetSettings').addEventListener('click', () => {
    saveSettings(DEFAULT_SETTINGS);
    openSettingsModal();
  });

  document.getElementById('btnSaveSettings').addEventListener('click', () => {
    saveSettings({
      sourceMode: document.getElementById('settingSourceMode').value,
      firebaseProjectId: document.getElementById('settingFirebaseProjectId').value.trim(),
      firebaseApiKey: document.getElementById('settingFirebaseApiKey').value.trim(),
      includeActiveFarm: document.getElementById('settingIncludeActiveFarm').checked,
      ghOwner: document.getElementById('settingGhOwner').value.trim() || 'lucasbouter',
      ghRepo: document.getElementById('settingGhRepo').value.trim() || 'LmdbHydroponics-Catalog',
      ghBranch: document.getElementById('settingGhBranch').value.trim() || 'main',
    });
    settingsBackdrop.hidden = true;
    loadAllCatalogData();
  });

  // Keyboard Escape closes modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      detailBackdrop.hidden = true;
      settingsBackdrop.hidden = true;
    }
  });

  // Initial Load
  loadAllCatalogData();
});
