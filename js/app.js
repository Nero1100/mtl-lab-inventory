// ===== MTL Lab Inventory App — v3.0.0 with Firestore real-time sync =====

// --- Lab → Location mapping (cascading dropdown) ---
const LAB_LOCATIONS = {
  'Small lab': ['Top', 'M', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'R1', 'R2', 'R3', 'R4', 'GS Room'],
  'Large lab': ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'B1', 'B2', 'B3', 'B4', 'B5', 'Shelf'],
};

// --- Data Layer: localStorage cache + Firestore real-time sync ---
const STORAGE_KEY = 'mtl_inventory_data';
const FIRESTORE_ITEMS_DOC = 'items/current'; // single-doc model
let workingData = [];

function saveLocalCache() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(workingData));
}

// Write the whole array (JSON string in field `data`) to Firestore.
// Fire-and-forget: callers do not await. Errors surface as Offline + toast.
function pushToFirestore() {
  if (typeof db === 'undefined' || !db || !firestoreReady) return;
  setSyncState('connecting');
  db.collection('items').doc('current').set({
    data: JSON.stringify(workingData),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  })
  .then(() => setSyncState('online'))
  .catch(err => {
    console.error('Firestore write failed:', err);
    setSyncState('offline');
    showToast('Sync failed — check connection');
  });
}

function saveData() {
  saveLocalCache();
  pushToFirestore();
}

function loadData() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    try { workingData = JSON.parse(stored); return; } catch (e) { /* fall through */ }
  }
  workingData = JSON.parse(JSON.stringify(INVENTORY_DATA));
  saveLocalCache();
}

function resetData() {
  workingData = JSON.parse(JSON.stringify(INVENTORY_DATA));
  saveData();
}

// --- Firestore real-time subscription ---
// Echo-loop safety by construction: this handler only mutates workingData and
// writes the LOCAL CACHE (never Firestore), and it early-returns when the remote
// payload is JSON-identical to the current workingData.
function subscribeToItems() {
  if (typeof db === 'undefined' || !db) return;
  db.collection('items').doc('current')
    .onSnapshot(snapshot => {
      if (!snapshot.exists) {
        // One-time migration: Firestore doc absent -> seed from local cache/defaults.
        console.log('Firestore doc missing — migrating local data');
        pushToFirestore();
        return;
      }
      let remote;
      try { remote = JSON.parse(snapshot.data().data || '[]'); }
      catch (e) { console.error('Bad Firestore payload', e); return; }
      if (!Array.isArray(remote)) return;
      if (JSON.stringify(remote) === JSON.stringify(workingData)) {
        setSyncState('online'); // echo of our own write, or no change
        return;
      }
      workingData = remote;
      saveLocalCache();          // cache only — do NOT write back to Firestore
      setSyncState('online');
      renderItemList();
      renderDashboard();
      renderAddForm();
      renderSettings();
      // Refresh detail in place ONLY if it is the active screen (showDetail()
      // calls showScreen('detail'), which would yank the user otherwise).
      const detailActive = document.getElementById('screenDetail').classList.contains('active');
      if (currentItem && detailActive) {
        const still = workingData.find(i => i.id === currentItem.id);
        if (still) showDetail(still.id);
      }
    }, err => {
      console.error('Firestore listen failed:', err);
      setSyncState('offline');
    });
}

// --- Sync indicator (revives orphaned CSS at styles.css) ---
function setupSyncIndicator() {
  const host = document.querySelector('#screenSearch .page-header');
  if (!host || document.getElementById('syncIndicator')) return;
  const el = document.createElement('div');
  el.id = 'syncIndicator';
  el.className = 'sync-indicator';
  el.innerHTML = '<span class="sync-dot sync-dot--connecting" id="syncDot"></span><span id="syncText">Connecting</span>';
  host.appendChild(el);
}

function setSyncState(state) { // 'online' | 'connecting' | 'offline'
  const dot = document.getElementById('syncDot');
  const text = document.getElementById('syncText');
  if (!dot || !text) return;
  dot.className = 'sync-dot sync-dot--' + state;
  text.textContent = state === 'online' ? 'Synced'
    : state === 'connecting' ? 'Syncing'
    : 'Offline';
}

// --- Export / Import ---
function exportData() {
  const exportObj = {
    exportedAt: new Date().toISOString(),
    itemCount: workingData.length,
    version: '3.0',
    items: workingData,
  };
  const dataStr = JSON.stringify(exportObj, null, 2);
  const blob = new Blob([dataStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const date = new Date().toISOString().split('T')[0];
  a.download = `MTL-Inventory-${date}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`Exported ${workingData.length} items`);
}

function triggerImport() {
  document.getElementById('importFileInput').click();
}

function handleImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const parsed = JSON.parse(event.target.result);
      // Accept both raw array or { items: [...] } wrapper
      const items = Array.isArray(parsed) ? parsed : parsed.items;
      if (!Array.isArray(items)) {
        showToast('Invalid file format');
        e.target.value = '';
        return;
      }
      // Basic validation
      if (items.length > 0 && (!items[0].id || !items[0].name)) {
        showToast('Invalid inventory data');
        e.target.value = '';
        return;
      }

      showConfirm(
        'Import Data',
        `Import ${items.length} items from "${file.name}"?\nThis will REPLACE your current ${workingData.length} items.`,
        'Import',
        () => {
          workingData = items;
          saveData();
          hideConfirm();
          showToast(`Imported ${items.length} items`);
          renderItemList();
          renderDashboard();
          renderSettings();
          renderAddForm();
          showScreen('search');
        }
      );
    } catch (err) {
      showToast('Failed to read file: ' + err.message);
    }
    e.target.value = '';
  };
  reader.readAsText(file);
}

// --- State ---
let currentFilter = 'all';
let currentSearch = '';
let currentItem = null;
let editingItemId = null;
let confirmCallback = null;
let mapReturnScreen = 'detail';
let mapReturnItemId = null;

// --- Navigation history for swipe-back ---
let screenHistory = [];
const SWIPE_BACK_SCREENS = ['detail', 'map', 'edit', 'floorplan'];

// --- Map Layout Data ---
const SMALL_LAB_LAYOUT = [
  { loc: 'M',  row: 1, col: 1, colSpan: 2, rowSpan: 1 },
  { loc: 'L1', row: 2, col: 1, colSpan: 1, rowSpan: 1 },
  { loc: 'R1', row: 2, col: 2, colSpan: 1, rowSpan: 1 },
  { loc: 'L2', row: 3, col: 1, colSpan: 1, rowSpan: 1 },
  { loc: 'R2', row: 3, col: 2, colSpan: 1, rowSpan: 1 },
  { loc: 'L3', row: 4, col: 1, colSpan: 1, rowSpan: 1 },
  { loc: 'R3', row: 4, col: 2, colSpan: 1, rowSpan: 1 },
  { loc: 'L4', row: 5, col: 1, colSpan: 1, rowSpan: 1 },
  { loc: 'R4', row: 5, col: 2, colSpan: 1, rowSpan: 3 },
  { loc: 'L5', row: 6, col: 1, colSpan: 1, rowSpan: 1 },
  { loc: 'L6', row: 7, col: 1, colSpan: 1, rowSpan: 1 },
];

const LARGE_LAB_LAYOUT = [
  { loc: 'T1', row: 1, col: 1, colSpan: 2, rowSpan: 1 },
  { loc: 'T2', row: 2, col: 1, colSpan: 1, rowSpan: 1 },
  { loc: 'T6', row: 2, col: 2, colSpan: 1, rowSpan: 2 },
  { loc: 'T3', row: 3, col: 1, colSpan: 1, rowSpan: 1 },
  { loc: 'T4', row: 4, col: 1, colSpan: 1, rowSpan: 1 },
  { loc: 'T7', row: 4, col: 2, colSpan: 1, rowSpan: 2 },
  { loc: 'T5', row: 5, col: 1, colSpan: 1, rowSpan: 1 },
  { loc: 'B1', row: 6, col: 1, colSpan: 2, rowSpan: 1 },
  { loc: 'B2', row: 7, col: 1, colSpan: 2, rowSpan: 1 },
  { loc: 'B3', row: 8, col: 1, colSpan: 2, rowSpan: 1 },
  { loc: 'B4', row: 9, col: 1, colSpan: 2, rowSpan: 1 },
  { loc: 'B5', row: 10, col: 1, colSpan: 2, rowSpan: 1 },
];

// Special locations that don't appear on the map grid
const SPECIAL_LOCATIONS = {
  'Shelf': {
    lab: 'Large lab',
    description: 'Under the table near the door in the Large Lab',
    icon: 'shelf',
  },
  'Top': {
    lab: 'Small lab',
    description: 'At the top of the cabinet in the Small Lab',
    icon: 'top',
  },
  'GS Room': {
    lab: 'Small lab',
    description: 'GS Room — a separate room adjacent to the Small Lab',
    icon: 'room',
  },
};

// --- SVG Icons ---
const ICONS = {
  box: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="3" y="8" width="18" height="13" rx="2" stroke="#2C7A7B" stroke-width="1.5"/><path d="M3 8L7 4H17L21 8" stroke="#2C7A7B" stroke-width="1.5" stroke-linejoin="round"/><path d="M9 13H15" stroke="#2C7A7B" stroke-width="1.5" stroke-linecap="round"/></svg>',
  search: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="8" cy="8" r="6" stroke="#FFFFFF" stroke-width="1.5"/><path d="M12.5 12.5L16 16" stroke="#FFFFFF" stroke-width="1.5" stroke-linecap="round"/></svg>',
  searchInactive: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="8" cy="8" r="6" stroke="#5C7480" stroke-width="1.5"/><path d="M12.5 12.5L16 16" stroke="#5C7480" stroke-width="1.5" stroke-linecap="round"/></svg>',
  dashboard: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="2" y="2" width="6" height="6" rx="1.5" stroke="#5C7480" stroke-width="1.5"/><rect x="10" y="2" width="6" height="6" rx="1.5" stroke="#5C7480" stroke-width="1.5"/><rect x="2" y="10" width="6" height="6" rx="1.5" stroke="#5C7480" stroke-width="1.5"/><rect x="10" y="10" width="6" height="6" rx="1.5" stroke="#5C7480" stroke-width="1.5"/></svg>',
  dashboardActive: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><rect x="2" y="2" width="6" height="6" rx="1.5" stroke="#FFFFFF" stroke-width="1.5"/><rect x="10" y="2" width="6" height="6" rx="1.5" stroke="#FFFFFF" stroke-width="1.5"/><rect x="2" y="10" width="6" height="6" rx="1.5" stroke="#FFFFFF" stroke-width="1.5"/><rect x="10" y="10" width="6" height="6" rx="1.5" stroke="#FFFFFF" stroke-width="1.5"/></svg>',
  add: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 3V15M3 9H15" stroke="#5C7480" stroke-width="1.5" stroke-linecap="round"/></svg>',
  addActive: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 3V15M3 9H15" stroke="#FFFFFF" stroke-width="1.5" stroke-linecap="round"/></svg>',
  settings: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="2.5" stroke="#5C7480" stroke-width="1.5"/><path d="M9 1.5V3.5M9 14.5V16.5M16.5 9H14.5M3.5 9H1.5M14.3 3.7L12.9 5.1M5.1 12.9L3.7 14.3M14.3 14.3L12.9 12.9M5.1 5.1L3.7 3.7" stroke="#5C7480" stroke-width="1.5" stroke-linecap="round"/></svg>',
  settingsActive: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><circle cx="9" cy="9" r="2.5" stroke="#FFFFFF" stroke-width="1.5"/><path d="M9 1.5V3.5M9 14.5V16.5M16.5 9H14.5M3.5 9H1.5M14.3 3.7L12.9 5.1M5.1 12.9L3.7 14.3M14.3 14.3L12.9 12.9M5.1 5.1L3.7 3.7" stroke="#FFFFFF" stroke-width="1.5" stroke-linecap="round"/></svg>',
  arrow: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M7 5L13 10L7 15" stroke="#2C7A7B" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  manual: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M10 3H6C4.9 3 4 3.9 4 5V19C4 20.1 4.9 21 6 21H10M14 3H18C19.1 3 20 3.9 20 5V19C20 20.1 19.1 21 18 21H14M14 3V21M10 3V21" stroke="#2C7A7B" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  purchase: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M2 3H4.5L6.5 14C6.6 14.6 7.1 15 7.7 15H17.3C17.9 15 18.4 14.6 18.5 14L20 7H5" stroke="#2C7A7B" stroke-width="1.5" stroke-linejoin="round"/><circle cx="9" cy="19" r="1.5" stroke="#2C7A7B" stroke-width="1.5"/><circle cx="17.5" cy="19" r="1.5" stroke="#2C7A7B" stroke-width="1.5"/></svg>',
  noResults: '<svg width="48" height="48" viewBox="0 0 48 48" fill="none"><circle cx="20" cy="20" r="14" stroke="#5C7480" stroke-width="2"/><path d="M31 31L42 42" stroke="#5C7480" stroke-width="2" stroke-linecap="round"/></svg>',
  edit: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M2 13.5V16H4.5L11.5 9L9 6.5L2 13.5Z" stroke="#FFFFFF" stroke-width="1.5" stroke-linejoin="round"/><path d="M9 6.5L11.5 9L14.5 6L12 3.5L9 6.5Z" stroke="#FFFFFF" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  trash: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M4 5H14M7 5V3.5C7 3 7.5 2.5 8 2.5H10C10.5 2.5 11 3 11 3.5V5M5.5 5L6 15C6 15.5 6.5 16 7 16H11C11.5 16 12 15.5 12 15L12.5 5" stroke="#EB5757" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  download: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1V11M8 11L4 7M8 11L12 7M2 13V14.5H14V13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  upload: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 11V1M8 1L4 5M8 1L12 5M2 13V14.5H14V13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// --- Toast ---
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('toast--show');
  setTimeout(() => toast.classList.remove('toast--show'), 2500);
}

// --- Confirm Dialog ---
function showConfirm(title, msg, okLabel, callback) {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMsg').textContent = msg;
  document.getElementById('confirmOk').textContent = okLabel;
  confirmCallback = callback;
  document.getElementById('confirmOverlay').classList.add('confirm-overlay--show');
}

function hideConfirm() {
  document.getElementById('confirmOverlay').classList.remove('confirm-overlay--show');
  confirmCallback = null;
}

// --- Screen Navigation ---
function showScreen(name) {
  // Track navigation history for swipe-back
  const activeScreen = document.querySelector('.screen.active');
  const prevName = activeScreen ? activeScreen.id.replace('screen', '').replace(/^./, c => c.toLowerCase()) : null;
  // Map element IDs back to screen names
  const idToName = { Search: 'search', Detail: 'detail', Dashboard: 'dashboard', Add: 'add', Settings: 'settings', Edit: 'edit', Map: 'map' };
  let prevScreenName = null;
  if (activeScreen) {
    for (const [suffix, name] of Object.entries(idToName)) {
      if (activeScreen.id === 'screen' + suffix) { prevScreenName = name; break; }
    }
  }
  if (!SWIPE_BACK_SCREENS.includes(name)) {
    // Tab-bar screens reset navigation history
    screenHistory = [];
  } else if (screenHistory.length > 0 && screenHistory[screenHistory.length - 1] === name) {
    // Returning to the sub-screen we came from (e.g. after saving edits or pressing a back button):
    // pop the stale entry instead of pushing the current screen again, so goBack() won't land on
    // a stale screen with cleared state (e.g. the edit form after saveEdit()).
    screenHistory.pop();
  } else if (prevScreenName && prevScreenName !== name) {
    // Pushing forward into a sub-screen — remember where we came from for swipe-back
    screenHistory.push(prevScreenName);
  }

  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screenMap = {
    search: 'screenSearch',
    detail: 'screenDetail',
    dashboard: 'screenDashboard',
    add: 'screenAdd',
    settings: 'screenSettings',
    edit: 'screenEdit',
    map: 'screenMap',
    floorplan: 'screenFloorPlan',
  };
  const screen = document.getElementById(screenMap[name]);
  if (screen) screen.classList.add('active');
  updateTabBars(name);
  const scrollArea = screen?.querySelector('.content-area--scroll');
  if (scrollArea) scrollArea.scrollTop = 0;
}

// --- Swipe-back gesture ---
function goBack() {
  if (screenHistory.length > 0) {
    const prev = screenHistory.pop();
    showScreenNoHistory(prev);
    return true;
  }
  // Fallback: go to search if no history
  showScreenNoHistory('search');
  return false;
}

// --- iOS zoom prevention ---
// iOS 16+ ignores user-scalable=no, so after keyboard dismisses,
// we must force the viewport to reset its scale.
function setupZoomPrevention() {
  const viewportMeta = document.querySelector('meta[name="viewport"]');
  const viewportContent = viewportMeta ? viewportMeta.getAttribute('content') : 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover';

  // After any input/touch that may trigger zoom, kill it
  function killZoom() {
    // Force a layout engine recalibration — iOS resets viewport scale on next repaint
    document.body.style.height = '99.9vh';
    document.body.offsetHeight; // force reflow
    document.body.style.height = '';
  }

  // Listen for keyboard dismissal events
  document.addEventListener('blur', function(e) {
    if (['INPUT','TEXTAREA','SELECT','BUTTON'].includes(e.target.tagName)) {
      setTimeout(killZoom, 50);
      setTimeout(killZoom, 200);
    }
  }, true);

  // Also kill zoom after any touch ends on interactive elements
  document.addEventListener('touchend', function(e) {
    var tag = e.target.tagName || '';
    if (['INPUT','TEXTAREA','SELECT','BUTTON','A'].includes(tag) || e.target.closest('button')) {
      setTimeout(killZoom, 100);
    }
  }, { passive: true });

  // --- Prevent double-tap zoom (iOS Safari ignores user-scalable=no) ---
  // Block dblclick entirely
  document.addEventListener('dblclick', function(e) { e.preventDefault(); }, { passive: false });

  // Block rapid consecutive touchend (double-tap detection)
  var lastTouchEnd = 0;
  document.addEventListener('touchend', function(e) {
    var now = Date.now();
    if (now - lastTouchEnd <= 300) {
      e.preventDefault();
    }
    lastTouchEnd = now;
  }, { passive: false });

  // Block iOS gesture events (pinch zoom)
  document.addEventListener('gesturestart', function(e) { e.preventDefault(); }, { passive: false });
  document.addEventListener('gesturechange', function(e) { e.preventDefault(); }, { passive: false });
  document.addEventListener('gestureend', function(e) { e.preventDefault(); }, { passive: false });
}

function showScreenNoHistory(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screenMap = {
    search: 'screenSearch',
    detail: 'screenDetail',
    dashboard: 'screenDashboard',
    add: 'screenAdd',
    settings: 'screenSettings',
    edit: 'screenEdit',
    map: 'screenMap',
    floorplan: 'screenFloorPlan',
  };
  const screen = document.getElementById(screenMap[name]);
  if (screen) screen.classList.add('active');
  updateTabBars(name);
  const scrollArea = screen?.querySelector('.content-area--scroll');
  if (scrollArea) scrollArea.scrollTop = 0;
}

function setupSwipeBack() {
  let startX = 0, startY = 0, swiping = false;
  const EDGE_THRESHOLD = 40; // px from left edge to start swipe
  const SWIPE_DISTANCE = 80;  // min px to trigger back
  const SWIPE_MAX_Y = 60;     // max vertical deviation

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    // Only start swipe from left edge
    if (touch.clientX > EDGE_THRESHOLD) {
      swiping = false;
      return;
    }
    // Only on sub-screens
    const active = document.querySelector('.screen.active');
    if (!active) return;
    const activeId = active.id;
    const isSubScreen = ['screenDetail', 'screenMap', 'screenEdit', 'screenFloorPlan'].includes(activeId);
    if (!isSubScreen) return;
    // Don't swipe back when an overlay is open
    const overlay = document.getElementById('confirmOverlay');
    if (overlay && overlay.classList.contains('active')) return;

    swiping = true;
    startX = touch.clientX;
    startY = touch.clientY;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!swiping || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const dx = touch.clientX - startX;
    const dy = Math.abs(touch.clientY - startY);
    // If swiping right and horizontal movement dominates
    if (dx > 0 && dx > dy) {
      // Prevent vertical scroll while swiping
      if (dx > 20) e.preventDefault();
    }
  }, { passive: false });

  document.addEventListener('touchend', (e) => {
    if (!swiping) return;
    swiping = false;
    const touch = e.changedTouches[0];
    const dx = touch.clientX - startX;
    const dy = Math.abs(touch.clientY - startY);
    if (dx >= SWIPE_DISTANCE && dy <= SWIPE_MAX_Y) {
      goBack();
    }
  }, { passive: true });
}

// --- Tab Bar Builder ---
function buildTabBar(activeTab) {
  const tabs = [
    { id: 'search', label: 'SEARCH', icon: activeTab === 'search' ? ICONS.search : ICONS.searchInactive },
    { id: 'dashboard', label: 'DASHBOARD', icon: activeTab === 'dashboard' ? ICONS.dashboardActive : ICONS.dashboard },
    { id: 'add', label: 'ADD', icon: activeTab === 'add' ? ICONS.addActive : ICONS.add },
    { id: 'settings', label: 'SETTINGS', icon: activeTab === 'settings' ? ICONS.settingsActive : ICONS.settings },
  ];
  let html = '<div class="tab-pill">';
  tabs.forEach(t => {
    html += `<div class="tab ${activeTab === t.id ? 'tab--active' : ''}" onclick="showScreen('${t.id}')">${t.icon}<span class="tab-label">${t.label}</span></div>`;
  });
  html += '</div>';
  return html;
}

function updateTabBars(activeTab) {
  ['tabBarSearch','tabBarDetail','tabBarDashboard','tabBarAdd','tabBarSettings'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = buildTabBar(activeTab);
  });
}

// --- Filter Chips ---
function setupFilterChips() {
  document.querySelectorAll('#filterChips .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#filterChips .chip').forEach(c => c.classList.remove('chip--active'));
      chip.classList.add('chip--active');
      currentFilter = chip.dataset.filter;
      renderItemList();
    });
  });
}

// --- Search ---
function setupSearch() {
  const input = document.getElementById('searchInput');
  input.addEventListener('input', (e) => {
    currentSearch = e.target.value.toLowerCase().trim();
    renderItemList();
  });
}

// --- Filter Logic ---
function getFilteredItems() {
  return workingData.filter(item => {
    if (currentFilter !== 'all') {
      if (currentFilter === '*Consumables') {
        if (item.category !== '*Consumables') return false;
      } else {
        if (item.lab !== currentFilter) return false;
      }
    }
    if (currentSearch) {
      const haystack = (item.id + ' ' + item.name + ' ' + item.detail + ' ' + item.category + ' ' + item.location + ' ' + item.lab).toLowerCase();
      if (!haystack.includes(currentSearch)) return false;
    }
    return true;
  });
}

// --- Render Item List ---
function renderItemList() {
  const list = document.getElementById('itemList');
  const filtered = getFilteredItems();

  // Update subtitle
  const subtitle = document.getElementById('searchSubtitle');
  if (subtitle) {
    const total = workingData.length;
    const labs = new Set(workingData.map(i => i.lab)).size;
    const cats = new Set(workingData.map(i => i.category)).size;
    subtitle.textContent = `${total} items · ${labs} labs · ${cats} categories`;
  }

  if (filtered.length === 0) {
    list.innerHTML = `<div class="no-results">${ICONS.noResults}<p>No items found</p><span>Try a different search or filter</span></div>`;
    return;
  }

  const display = filtered.slice(0, 100);
  list.innerHTML = display.map(item => `
    <div class="item-card" onclick="showDetail('${item.id}')">
      <div class="item-icon">${ICONS.box}</div>
      <div class="card-content">
        <div class="card-name">${escapeHtml(item.name)}</div>
        <div class="card-id-row">
          <span class="card-id">${escapeHtml(item.id)}</span>
          <div class="status-badge status-badge--${getStatusClass(item.status)}">
            <div class="status-dot"></div>
            <span class="status-badge-text">${escapeHtml(item.status || 'Available')}</span>
          </div>
        </div>
        <div class="card-meta">${escapeHtml(item.category)} · <span style="color:var(--accent-primary);font-weight:600;cursor:pointer;" onclick="event.stopPropagation();showLocationMap('${escapeHtml(item.location)}','${escapeHtml(item.lab)}','search',null)">Location ${escapeHtml(item.location)} 📍</span> · Qty ${item.quantity}</div>
      </div>
    </div>
  `).join('');
}

// --- Show Detail ---
function showDetail(itemId) {
  const item = workingData.find(i => i.id === itemId);
  if (!item) return;
  currentItem = item;

  document.getElementById('detailItemId').textContent = item.id;

  const content = document.getElementById('detailContent');
  content.innerHTML = `
    <div class="detail-scroll">
      <div class="detail-hero">
        <div class="detail-hero-circle">
          <svg width="36" height="36" viewBox="0 0 36 36" fill="none"><path d="M10 18L15 23L26 12" stroke="#5BCFC5" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
      </div>
      <h2 class="detail-name">${escapeHtml(item.name)}</h2>
      <div class="badge-row">
        <div class="cat-badge">${escapeHtml(item.category)}</div>
        <div class="status-badge-detail status-badge-detail--${getStatusClass(item.status)}">
          <div class="status-dot"></div>
          <span>${escapeHtml(item.status || 'Available')}</span>
        </div>
      </div>
      <div class="info-card">
        <div class="info-row"><span class="info-label">Item ID</span><span class="info-value info-value-mono">${escapeHtml(item.id)}</span></div>
        <div class="info-sep"></div>
        <div class="info-row"><span class="info-label">Lab</span><span class="info-value">${escapeHtml(item.lab)}</span></div>
        <div class="info-sep"></div>
        <div class="info-row"><span class="info-label">Location</span><span class="info-value info-value-mono" style="color:var(--accent-primary);cursor:pointer;text-decoration:underline;" onclick="showLocationMap('${escapeHtml(item.location)}','${escapeHtml(item.lab)}','detail','${escapeHtml(item.id)}')">${escapeHtml(item.location)} <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="display:inline;vertical-align:middle;margin-left:2px;"><path d="M5 3L9 7L5 11" stroke="#2C7A7B" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span></div>
        <div class="info-sep"></div>
        <div class="info-row"><span class="info-label">Quantity</span><span class="info-value">${item.quantity}</span></div>
        ${item.detail ? `<div class="info-sep"></div><div class="info-row"><span class="info-label">Detail</span><span class="info-value">${escapeHtml(item.detail)}</span></div>` : ''}
        ${item.notes ? `<div class="info-sep"></div><div class="info-row"><span class="info-label">Notes</span><span class="info-value">${escapeHtml(item.notes)}</span></div>` : ''}
      </div>
      ${renderCalibDetail(item)}
      ${item.manual ? `
        <a class="manual-card" href="${escapeHtml(item.manual)}" target="_blank" rel="noopener">
          <div class="manual-icon">${ICONS.manual}</div>
          <div class="manual-content">
            <span class="manual-label">Product Manual</span>
            <span class="manual-url">${escapeHtml(item.manual)}</span>
          </div>
          ${ICONS.arrow}
        </a>
      ` : ''}
      ${item.purchase ? `
        <a class="manual-card" href="${escapeHtml(item.purchase)}" target="_blank" rel="noopener">
          <div class="manual-icon">${ICONS.purchase}</div>
          <div class="manual-content">
            <span class="manual-label">Purchase Link</span>
            <span class="manual-url">${escapeHtml(item.purchase)}</span>
          </div>
          ${ICONS.arrow}
        </a>
      ` : ''}
      <div class="detail-actions">
        <button class="btn-edit" onclick="showEdit('${item.id}')">${ICONS.edit} Edit</button>
        <button class="btn-delete" onclick="confirmDelete('${item.id}')">${ICONS.trash} Delete</button>
      </div>
    </div>
  `;

  showScreen('detail');
}

// --- Show Location Map ---
function showLocationMap(location, lab, fromScreen, fromItemId) {
  mapReturnScreen = fromScreen || 'detail';
  mapReturnItemId = fromItemId || null;

  document.getElementById('mapLocationId').textContent = location;
  document.getElementById('mapBackLabel').textContent = fromScreen === 'search' ? 'Search' : (fromScreen === 'floorplan' ? 'Floor Plan' : 'Detail');

  const content = document.getElementById('mapContent');
  const isSpecial = SPECIAL_LOCATIONS[location];

  let mapLab = lab;
  if (isSpecial) {
    mapLab = isSpecial.lab;
  }

  const layout = mapLab === 'Small lab' ? SMALL_LAB_LAYOUT : LARGE_LAB_LAYOUT;
  const gridClass = mapLab === 'Small lab' ? 'map-grid--small' : 'map-grid--large';
  const totalRows = mapLab === 'Small lab' ? 7 : 10;

  const blocksHtml = layout.map(block => {
    const isHighlighted = block.loc === location;
    const isDim = !isHighlighted && !isSpecial;
    const cls = `map-block ${isHighlighted ? 'map-block--highlighted' : ''} ${isDim ? 'map-block--dim' : ''} ${block.colSpan > 1 ? 'map-block--full' : ''}`;
    const style = `grid-column: ${block.col}${block.colSpan > 1 ? ' / -1' : ''}; grid-row: ${block.row}${block.rowSpan > 1 ? ` / ${block.row + block.rowSpan}` : ''};`;
    return `<div class="${cls}" style="${style}">${block.loc}</div>`;
  }).join('');

  const itemsAtLoc = workingData.filter(i => i.location === location && i.lab === lab);
  const statusColor = {
    available: '#5BCFC5', 'in-use': '#F59E0B', maintenance: '#3B82F6',
    unavailable: '#EF4444', lost: '#9CA3AF'
  };
  const itemsHtml = itemsAtLoc.length > 0 ? `
    <div class="map-items-card">
      <div class="map-items-title">Items at this location (${itemsAtLoc.length})</div>
      <div class="map-items-list">
        ${itemsAtLoc.map(item => `
          <div class="map-item-row" onclick="showDetail('${escapeHtml(item.id)}')">
            <div class="map-item-dot" style="background:${statusColor[getStatusClass(item.status)] || '#5BCFC5'}"></div>
            <span class="map-item-name">${escapeHtml(item.name)}</span>
            <span class="map-item-id">${escapeHtml(item.id)}</span>
          </div>
        `).join('')}
      </div>
    </div>
  ` : '';

  const specialHtml = isSpecial ? `
    <div class="map-special-card">
      <div class="map-special-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          ${isSpecial.icon === 'shelf' ? '<path d="M3 4H21V8H3V4Z M3 10H21V14H3V10Z M3 16H21V20H3V16Z" stroke="#B8860B" stroke-width="1.5" stroke-linejoin="round"/>' :
            isSpecial.icon === 'top' ? '<path d="M4 20V8L12 3L20 8V20H4Z" stroke="#B8860B" stroke-width="1.5" stroke-linejoin="round"/><path d="M9 20V14H15V20" stroke="#B8860B" stroke-width="1.5"/>' :
            '<rect x="3" y="3" width="18" height="18" rx="2" stroke="#B8860B" stroke-width="1.5"/><path d="M3 9H21M9 3V21" stroke="#B8860B" stroke-width="1.5"/>'}
        </svg>
      </div>
      <div class="map-special-text">
        <div class="map-special-label">Special Location</div>
        <div class="map-special-desc">${escapeHtml(isSpecial.description)}</div>
      </div>
    </div>
  ` : '';

  content.innerHTML = `
    <div class="map-scroll">
      <div class="map-header">
        <div class="map-header-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 2C8.13 2 5 5.13 5 9C5 13.25 12 22 12 22S19 13.25 19 9C19 5.13 15.87 2 12 2Z" stroke="#2C7A7B" stroke-width="1.5"/><circle cx="12" cy="9" r="2.5" stroke="#2C7A7B" stroke-width="1.5"/></svg>
        </div>
        <div class="map-header-info">
          <div class="map-header-loc">${escapeHtml(location)}</div>
          <div class="map-header-lab">${escapeHtml(lab)}</div>
        </div>
      </div>

      ${specialHtml}

      <div class="map-container">
        <div class="map-title">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2" stroke="#2C7A7B" stroke-width="1.5"/><path d="M2 6H14M6 2V14" stroke="#2C7A7B" stroke-width="1.5"/></svg>
          ${escapeHtml(mapLab)} — Floor Plan
        </div>
        <div class="map-grid ${gridClass}" style="grid-template-rows: repeat(${totalRows}, minmax(48px, 1fr));">
          ${blocksHtml}
        </div>
        <div class="map-legend">
          <div class="map-legend-item"><div class="map-legend-dot" style="background:var(--accent-light);"></div>Selected</div>
          <div class="map-legend-item"><div class="map-legend-dot" style="background:#F5F9F8;border:1px solid var(--border-subtle);"></div>Other areas</div>
        </div>
      </div>

      <div class="map-info-card">
        <div class="map-info-row"><span class="map-info-label">Location Code</span><span class="map-info-value map-info-value-mono">${escapeHtml(location)}</span></div>
        <div class="map-info-sep"></div>
        <div class="map-info-row"><span class="map-info-label">Lab</span><span class="map-info-value">${escapeHtml(lab)}</span></div>
        <div class="map-info-sep"></div>
        <div class="map-info-row"><span class="map-info-label">Items here</span><span class="map-info-value">${itemsAtLoc.length}</span></div>
      </div>

      ${itemsHtml}
    </div>
  `;

  showScreen('map');
}

// --- Show Lab Floor Plan (whole lab, every location shows its item count) ---
function showLabFloorPlan(lab) {
  document.getElementById('floorPlanLabId').textContent = lab;
  document.getElementById('floorPlanBackLabel').textContent = 'Dashboard';

  const content = document.getElementById('floorPlanContent');
  const isSmall = lab === 'Small lab';
  const layout = isSmall ? SMALL_LAB_LAYOUT : LARGE_LAB_LAYOUT;
  const gridClass = isSmall ? 'map-grid--small' : 'map-grid--large';
  const totalRows = isSmall ? 7 : 10;

  const countAt = (loc) => workingData.filter(i => i.lab === lab && i.location === loc).length;
  const totalItems = workingData.filter(i => i.lab === lab).length;
  const specialLocs = Object.entries(SPECIAL_LOCATIONS).filter(([, v]) => v.lab === lab);

  // Grid blocks: location code + item count badge
  const blocksHtml = layout.map(block => {
    const count = countAt(block.loc);
    const hasItems = count > 0;
    const cls = `map-block map-block--lab ${hasItems ? 'map-block--has-items' : 'map-block--empty'} ${block.colSpan > 1 ? 'map-block--full' : ''}`;
    const style = `grid-column: ${block.col}${block.colSpan > 1 ? ' / -1' : ''}; grid-row: ${block.row}${block.rowSpan > 1 ? ` / ${block.row + block.rowSpan}` : ''};`;
    return `<div class="${cls}" style="${style}" onclick="showLocationMap('${block.loc}','${lab}','floorplan',null)">
      <span class="map-block-loc">${block.loc}</span>
      <span class="map-block-count">${count}</span>
    </div>`;
  }).join('');

  // Special locations (Top / GS Room / Shelf) — shown as cards with counts
  const specialsHtml = specialLocs.map(([loc, info]) => {
    const count = countAt(loc);
    return `
    <div class="map-special-card map-special-card--link" onclick="showLocationMap('${loc}','${lab}','floorplan',null)">
      <div class="map-special-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          ${info.icon === 'shelf' ? '<path d="M3 4H21V8H3V4Z M3 10H21V14H3V10Z M3 16H21V20H3V16Z" stroke="#B8860B" stroke-width="1.5" stroke-linejoin="round"/>' :
            info.icon === 'top' ? '<path d="M4 20V8L12 3L20 8V20H4Z" stroke="#B8860B" stroke-width="1.5" stroke-linejoin="round"/><path d="M9 20V14H15V20" stroke="#B8860B" stroke-width="1.5"/>' :
            '<rect x="3" y="3" width="18" height="18" rx="2" stroke="#B8860B" stroke-width="1.5"/><path d="M3 9H21M9 3V21" stroke="#B8860B" stroke-width="1.5"/>'}
        </svg>
      </div>
      <div class="map-special-text">
        <div class="map-special-label">${escapeHtml(loc)}<span class="map-special-count">${count} item${count === 1 ? '' : 's'}</span></div>
        <div class="map-special-desc">${escapeHtml(info.description)}</div>
      </div>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="flex-shrink:0;"><path d="M6 3L11 8L6 13" stroke="#2C7A7B" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>`;
  }).join('');

  content.innerHTML = `
    <div class="map-scroll">
      <div class="map-header">
        <div class="map-header-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 2C8.13 2 5 5.13 5 9C5 13.25 12 22 12 22S19 13.25 19 9C19 5.13 15.87 2 12 2Z" stroke="#2C7A7B" stroke-width="1.5"/><circle cx="12" cy="9" r="2.5" stroke="#2C7A7B" stroke-width="1.5"/></svg>
        </div>
        <div class="map-header-info">
          <div class="map-header-loc">${escapeHtml(lab)}</div>
          <div class="map-header-lab">${totalItems} items total</div>
        </div>
      </div>

      ${specialsHtml}

      <div class="map-container">
        <div class="map-title">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2" stroke="#2C7A7B" stroke-width="1.5"/><path d="M2 6H14M6 2V14" stroke="#2C7A7B" stroke-width="1.5"/></svg>
          ${escapeHtml(lab)} — Floor Plan
        </div>
        <div class="map-grid ${gridClass}" style="grid-template-rows: repeat(${totalRows}, minmax(56px, 1fr));">
          ${blocksHtml}
        </div>
        <div class="map-legend">
          <div class="map-legend-item"><div class="map-legend-dot" style="background:var(--accent-primary);"></div>Has items</div>
          <div class="map-legend-item"><div class="map-legend-dot" style="background:#F5F9F8;border:1px solid var(--border-subtle);"></div>Empty</div>
        </div>
      </div>

      <div class="map-hint">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" stroke="#5C7480" stroke-width="1.2"/><path d="M7 6.5V9.5M7 4.5V4.6" stroke="#5C7480" stroke-width="1.2" stroke-linecap="round"/></svg>
        Tap any location to see the items stored there
      </div>
    </div>
  `;

  showScreen('floorplan');
}
function showEdit(itemId) {
  const item = workingData.find(i => i.id === itemId);
  if (!item) return;
  editingItemId = itemId;

  document.getElementById('editItemId').textContent = item.id;
  document.getElementById('editTitle').textContent = 'Edit Equipment';

  renderEditForm(item);
  showScreen('edit');
}

// --- Render Edit Form (with cascading Location) ---
function renderEditForm(item) {
  const labs = [...new Set(workingData.map(i => i.lab))].sort();
  const categories = [...new Set(workingData.map(i => i.category))].sort();
  const statuses = ['Available', 'In Use', 'Maintenance', 'Unavailable', 'Lost'];

  // Use LAB_LOCATIONS for the item's current lab
  const currentLocations = LAB_LOCATIONS[item.lab] || [];

  document.getElementById('editForm').innerHTML = `
    <div class="form-group">
      <label class="form-label">Item ID</label>
      <input class="form-input" type="text" id="editFieldId" value="${escapeHtml(item.id)}">
    </div>
    <div class="form-group">
      <label class="form-label">Item Name</label>
      <input class="form-input" type="text" id="editFieldName" value="${escapeHtml(item.name)}">
    </div>
    <div class="form-group">
      <label class="form-label">Lab</label>
      <select class="form-select" id="editFieldLab" onchange="onEditLabChange()">${labs.map(l => `<option ${l === item.lab ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select>
    </div>
    <div class="form-group">
      <label class="form-label">Category</label>
      <div class="combobox-wrapper">
        <input class="form-input combobox-input" type="text" id="editFieldCategory" list="editCategoryList" value="${escapeHtml(item.category)}" placeholder="Select or type new category">
        <span class="combobox-arrow">▾</span>
        <datalist id="editCategoryList">${categories.map(c => `<option value="${escapeHtml(c)}">`).join('')}</datalist>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Location</label>
      <select class="form-select" id="editFieldLocation">${currentLocations.map(l => `<option ${l === item.location ? 'selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select>
    </div>
    <div class="form-group">
      <label class="form-label">Quantity</label>
      <input class="form-input" type="number" id="editFieldQty" value="${item.quantity}" min="0">
    </div>
    <div class="form-group">
      <label class="form-label">Status</label>
      <select class="form-select" id="editFieldStatus">${statuses.map(s => `<option ${s === (item.status || 'Available') ? 'selected' : ''}>${s}</option>`).join('')}</select>
    </div>
    <div class="form-group">
      <label class="calib-toggle">
        <input type="checkbox" id="editFieldCalibration" onchange="onEditCalibrationToggle()" ${item.calibration ? 'checked' : ''}>
        <span>Track calibration</span>
      </label>
    </div>
    <div class="calib-fields" id="editCalibFields" style="display:${item.calibration ? 'flex' : 'none'};">
      <div class="form-group">
        <label class="form-label">Last Calibration Date</label>
        ${dateSegHtml('editFieldLastCalibration', item.lastCalibration || '')}
      </div>
      <div class="form-group">
        <label class="form-label">Next Calibration Date</label>
        ${dateSegHtml('editFieldNextCalibration', item.nextCalibration || '')}
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Detail</label>
      <input class="form-input" type="text" id="editFieldDetail" value="${escapeHtml(item.detail || '')}" placeholder="e.g. Temperature, 1000V">
    </div>
    <div class="form-group">
      <label class="form-label">Notes</label>
      <textarea class="form-input form-textarea" id="editFieldNotes" placeholder="Additional notes...">${escapeHtml(item.notes || '')}</textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Manual Link</label>
      <input class="form-input" type="text" id="editFieldManual" value="${escapeHtml(item.manual || '')}" placeholder="https://...">
    </div>
    <div class="form-group">
      <label class="form-label">Purchase Link</label>
      <input class="form-input" type="text" id="editFieldPurchase" value="${escapeHtml(item.purchase || '')}" placeholder="https://...">
    </div>
    <button class="form-submit" onclick="saveEdit()">Save Changes</button>
    <button class="form-submit form-submit--danger" onclick="confirmDelete('${item.id}')">Delete This Item</button>
  `;
}

// --- Cascading: Lab change updates Location options (Edit) ---
function onEditLabChange() {
  const lab = document.getElementById('editFieldLab').value;
  const locSelect = document.getElementById('editFieldLocation');
  const locations = LAB_LOCATIONS[lab] || [];
  locSelect.innerHTML = locations.map(l => `<option>${escapeHtml(l)}</option>`).join('');
}

// --- Cascading: Lab change updates Location options (Add) ---
function onAddLabChange() {
  const lab = document.getElementById('addFieldLab').value;
  const locSelect = document.getElementById('addFieldLocation');
  const locations = LAB_LOCATIONS[lab] || [];
  locSelect.innerHTML = locations.map(l => `<option>${escapeHtml(l)}</option>`).join('');
}

// --- Show/hide calibration date fields when "Track calibration" is checked ---
function onAddCalibrationToggle() {
  const checked = document.getElementById('addFieldCalibration').checked;
  const el = document.getElementById('addCalibFields');
  if (el) el.style.display = checked ? 'flex' : 'none';
}
function onEditCalibrationToggle() {
  const checked = document.getElementById('editFieldCalibration').checked;
  const el = document.getElementById('editCalibFields');
  if (el) el.style.display = checked ? 'flex' : 'none';
}

// --- Segmented date input (Year-Month-Day) with auto-advance ---
const DATE_PART_NEXT = { year: 'month', month: 'day' };
const DATE_PART_PREV = { month: 'year', day: 'month' };

function dateSegHtml(id, value) {
  const parts = String(value || '').split('-');
  const year = escapeHtml(parts[0] || '');
  const month = escapeHtml(parts[1] || '');
  const day = escapeHtml(parts[2] || '');
  return `
    <div class="date-seg" id="${id}">
      <input class="form-input date-seg-input" type="text" inputmode="numeric" autocomplete="off" maxlength="4" placeholder="YYYY" data-part="year" value="${year}">
      <span class="date-seg-sep">-</span>
      <input class="form-input date-seg-input" type="text" inputmode="numeric" autocomplete="off" maxlength="2" placeholder="MM" data-part="month" value="${month}">
      <span class="date-seg-sep">-</span>
      <input class="form-input date-seg-input" type="text" inputmode="numeric" autocomplete="off" maxlength="2" placeholder="DD" data-part="day" value="${day}">
    </div>
  `;
}

function getDateSegValue(id) {
  const el = document.getElementById(id);
  if (!el) return '';
  const y = el.querySelector('[data-part="year"]').value.trim();
  const m = el.querySelector('[data-part="month"]').value.trim();
  const d = el.querySelector('[data-part="day"]').value.trim();
  if (!y || !m || !d) return '';
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function setupDateSegAutoAdvance() {
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.classList || !el.classList.contains('date-seg-input')) return;
    const max = parseInt(el.getAttribute('maxlength') || '0', 10);
    let v = el.value.replace(/\D/g, '');
    if (v.length > max) v = v.slice(0, max);
    if (v !== el.value) el.value = v;
    const nextPart = DATE_PART_NEXT[el.dataset.part];
    if (nextPart && v.length >= max) {
      const next = el.closest('.date-seg').querySelector(`[data-part="${nextPart}"]`);
      if (next) next.focus();
    }
  });
  document.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!el.classList || !el.classList.contains('date-seg-input')) return;
    if (e.key === 'Backspace' && el.value === '') {
      const prevPart = DATE_PART_PREV[el.dataset.part];
      if (prevPart) {
        const prev = el.closest('.date-seg').querySelector(`[data-part="${prevPart}"]`);
        if (prev) prev.focus();
      }
    }
  });
}

// --- Save Edit ---
function saveEdit() {
  const idx = workingData.findIndex(i => i.id === editingItemId);
  if (idx === -1) {
    showToast('Item no longer exists');
    goBack();
    return;
  }

  const newId = document.getElementById('editFieldId').value.trim();
  const name = document.getElementById('editFieldName').value.trim();

  if (!name) {
    showToast('Item name cannot be empty');
    return;
  }
  if (!newId) {
    showToast('Item ID cannot be empty');
    return;
  }

  if (newId !== editingItemId && workingData.some(i => i.id === newId)) {
    showToast('Item ID already exists');
    return;
  }

  const status = document.getElementById('editFieldStatus').value;
  const isCalibration = document.getElementById('editFieldCalibration').checked;
  workingData[idx] = {
    id: newId,
    name: name,
    lab: document.getElementById('editFieldLab').value,
    category: document.getElementById('editFieldCategory').value,
    location: document.getElementById('editFieldLocation').value,
    quantity: parseInt(document.getElementById('editFieldQty').value) || 0,
    status: status,
    detail: document.getElementById('editFieldDetail').value.trim(),
    notes: document.getElementById('editFieldNotes').value.trim(),
    manual: document.getElementById('editFieldManual').value.trim(),
    purchase: document.getElementById('editFieldPurchase').value.trim(),
  };
  if (isCalibration) {
    workingData[idx].calibration = true;
    workingData[idx].lastCalibration = getDateSegValue('editFieldLastCalibration');
    workingData[idx].nextCalibration = getDateSegValue('editFieldNextCalibration');
  } else {
    delete workingData[idx].calibration;
    delete workingData[idx].lastCalibration;
    delete workingData[idx].nextCalibration;
  }

  saveData();
  editingItemId = null;
  showToast('Changes saved');
  renderItemList();
  renderDashboard();
  renderSettings();
  showDetail(newId);
}

// --- Confirm Delete ---
function confirmDelete(itemId) {
  const item = workingData.find(i => i.id === itemId);
  if (!item) return;
  showConfirm(
    'Delete Item',
    `Are you sure you want to delete "${item.name}"? This cannot be undone.`,
    'Delete',
    () => {
      workingData = workingData.filter(i => i.id !== itemId);
      saveData();
      hideConfirm();
      showToast('Item deleted');
      renderItemList();
      renderDashboard();
      renderSettings();
      showScreen('search');
    }
  );
}

// --- Render Dashboard ---
function renderDashboard() {
  const total = workingData.length;
  const smallLab = workingData.filter(i => i.lab === 'Small lab').length;
  const largeLab = workingData.filter(i => i.lab === 'Large lab').length;

  const calibItems = workingData.filter(i => i.calibration === true).sort((a, b) => {
    const ia = getCalibrationInfo(a);
    const ib = getCalibrationInfo(b);
    const ua = ia && ia.daysUntil !== null ? ia.daysUntil : Infinity;
    const ub = ib && ib.daysUntil !== null ? ib.daysUntil : Infinity;
    return ua - ub; // soonest-due first
  });

  const calibHtml = calibItems.length === 0
    ? `<div class="calib-empty">No items in calibration</div>`
    : calibItems.map(item => {
        const info = getCalibrationInfo(item);
        const urgent = info.dueSoon;
        return `
          <div class="calib-row ${urgent ? 'calib-row--urgent' : ''}" onclick="showDetail('${escapeHtml(item.id)}')">
            <div class="calib-dot" style="background:${urgent ? '#EF4444' : 'var(--accent-light)'}"></div>
            <div class="calib-body">
              <div class="calib-name">${escapeHtml(item.name)}</div>
              <div class="calib-meta">${escapeHtml(item.id)} · ${escapeHtml(item.lab)}</div>
              <div class="calib-days">
                <span class="calib-since">${formatDaysSince(info.daysSince)}</span>
                <span class="calib-sep">·</span>
                <span class="calib-until ${urgent ? 'calib-until--urgent' : ''}">${formatDaysUntil(info.daysUntil)}</span>
              </div>
            </div>
          </div>
        `;
      }).join('');

  document.getElementById('dashboardContent').innerHTML = `
    <div class="big-stat-card">
      <div class="big-stat-num">${total}</div>
      <div class="big-stat-label">Total Items in Inventory</div>
    </div>
    <div class="stat-row">
      <div class="stat-card-small stat-card-small--clickable" onclick="showLabFloorPlan('Small lab')">
        <div class="stat-card-num">${smallLab}</div>
        <div class="stat-card-label">Small Lab</div>
        <div class="stat-card-hint">Floor plan <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M5 2.5L8.5 6L5 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      </div>
      <div class="stat-card-small stat-card-small--clickable" onclick="showLabFloorPlan('Large lab')">
        <div class="stat-card-num">${largeLab}</div>
        <div class="stat-card-label">Large Lab</div>
        <div class="stat-card-hint">Floor plan <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M5 2.5L8.5 6L5 9.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
      </div>
    </div>
    <div class="category-card calibration-card">
      <div class="category-title">Calibration</div>
      ${calibHtml}
    </div>
  `;
}

// --- Render Add Form (with cascading Location) ---
function renderAddForm() {
  const labs = [...new Set(workingData.map(i => i.lab))].sort();
  const categories = [...new Set(workingData.map(i => i.category))].sort();
  const statuses = ['Available', 'In Use', 'Maintenance', 'Unavailable', 'Lost'];
  const defaultLab = labs[0] || 'Small lab';
  const defaultLocations = LAB_LOCATIONS[defaultLab] || [];

  document.getElementById('addForm').innerHTML = `
    <div class="form-group">
      <label class="form-label">Item Name *</label>
      <input class="form-input" type="text" id="addFieldname" placeholder="Enter item name">
    </div>
    <div class="form-group">
      <label class="form-label">Lab</label>
      <select class="form-select" id="addFieldLab" onchange="onAddLabChange()">${labs.map(l => `<option>${escapeHtml(l)}</option>`).join('')}</select>
    </div>
    <div class="form-group">
      <label class="form-label">Category</label>
      <div class="combobox-wrapper">
        <input class="form-input combobox-input" type="text" id="addFieldCategory" list="addCategoryList" value="${escapeHtml(categories[0] || '')}" placeholder="Select or type new category">
        <span class="combobox-arrow">▾</span>
        <datalist id="addCategoryList">${categories.map(c => `<option value="${escapeHtml(c)}">`).join('')}</datalist>
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Location</label>
      <select class="form-select" id="addFieldLocation">${defaultLocations.map(l => `<option>${escapeHtml(l)}</option>`).join('')}</select>
    </div>
    <div class="form-group">
      <label class="form-label">Quantity</label>
      <input class="form-input" type="number" id="addFieldQty" value="1" min="1">
    </div>
    <div class="form-group">
      <label class="form-label">Status</label>
      <select class="form-select" id="addFieldStatus">${statuses.map(s => `<option>${s}</option>`).join('')}</select>
    </div>
    <div class="form-group">
      <label class="calib-toggle">
        <input type="checkbox" id="addFieldCalibration" onchange="onAddCalibrationToggle()">
        <span>Track calibration</span>
      </label>
    </div>
    <div class="calib-fields" id="addCalibFields" style="display:none;">
      <div class="form-group">
        <label class="form-label">Last Calibration Date</label>
        ${dateSegHtml('addFieldLastCalibration', '')}
      </div>
      <div class="form-group">
        <label class="form-label">Next Calibration Date</label>
        ${dateSegHtml('addFieldNextCalibration', '')}
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Detail</label>
      <input class="form-input" type="text" id="addFieldDetail" placeholder="e.g. Temperature, 1000V">
    </div>
    <div class="form-group">
      <label class="form-label">Notes</label>
      <textarea class="form-input form-textarea" id="addFieldNotes" placeholder="Additional notes..."></textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Manual Link</label>
      <input class="form-input" type="text" id="addFieldManual" placeholder="https://...">
    </div>
    <div class="form-group">
      <label class="form-label">Purchase Link</label>
      <input class="form-input" type="text" id="addFieldPurchase" placeholder="https://...">
    </div>
    <button class="form-submit" onclick="saveAdd()">Add to Inventory</button>
  `;
}

// --- Save New Item ---
function saveAdd() {
  const name = document.getElementById('addFieldname').value.trim();
  if (!name) {
    showToast('Item name is required');
    return;
  }

  const lab = document.getElementById('addFieldLab').value;
  const prefix = lab === 'Small lab' ? 'SL' : 'LL';
  const existing = workingData.filter(i => i.id.startsWith(prefix)).map(i => parseInt(i.id.split('-')[1]) || 0);
  const maxNum = existing.length > 0 ? Math.max(...existing) : 0;
  const newId = `${prefix}-${String(maxNum + 1).padStart(4, '0')}`;

  const status = document.getElementById('addFieldStatus').value;
  const isCalibration = document.getElementById('addFieldCalibration').checked;
  const newItem = {
    id: newId,
    name: name,
    lab: lab,
    category: document.getElementById('addFieldCategory').value,
    location: document.getElementById('addFieldLocation').value,
    quantity: parseInt(document.getElementById('addFieldQty').value) || 1,
    status: status,
    detail: document.getElementById('addFieldDetail').value.trim(),
    notes: document.getElementById('addFieldNotes').value.trim(),
    manual: document.getElementById('addFieldManual').value.trim(),
    purchase: document.getElementById('addFieldPurchase').value.trim(),
  };
  if (isCalibration) {
    newItem.calibration = true;
    newItem.lastCalibration = getDateSegValue('addFieldLastCalibration');
    newItem.nextCalibration = getDateSegValue('addFieldNextCalibration');
  }
  workingData.push(newItem);

  saveData();
  showToast(`Added: ${newId}`);
  renderItemList();
  renderDashboard();
  renderSettings();
  renderAddForm();
  showScreen('search');
}

// --- Render Settings (with Export/Import) ---
function renderSettings() {
  const total = workingData.length;
  const categories = new Set(workingData.map(i => i.category)).size;
  const locations = new Set(workingData.map(i => i.location)).size;
  const labs = new Set(workingData.map(i => i.lab)).size;

  document.getElementById('settingsList').innerHTML = `
    <div class="settings-card">
      <div class="settings-row"><span class="settings-label">Total Items</span><span class="settings-value">${total}</span></div>
      <div class="settings-sep"></div>
      <div class="settings-row"><span class="settings-label">Categories</span><span class="settings-value">${categories}</span></div>
      <div class="settings-sep"></div>
      <div class="settings-row"><span class="settings-label">Locations</span><span class="settings-value">${locations}</span></div>
      <div class="settings-sep"></div>
      <div class="settings-row"><span class="settings-label">Labs</span><span class="settings-value">${labs}</span></div>
    </div>
    <div class="settings-card">
      <div class="settings-row"><span class="settings-label">Data Source</span><span class="settings-value">MTL Lab Inventory.xlsx</span></div>
      <div class="settings-sep"></div>
      <div class="settings-row"><span class="settings-label">Storage</span><span class="settings-value">Firestore + local cache</span></div>
      <div class="settings-sep"></div>
      <div class="settings-row"><span class="settings-label">Version</span><span class="settings-value">3.0.0</span></div>
    </div>
    <div class="sync-info-card">
      <div class="sync-info-title">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 1V11M8 11L4 7M8 11L12 7M2 13V14.5H14V13" stroke="#2C7A7B" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Share Data with Team
      </div>
      <p style="font-size:12px;color:var(--text-secondary);line-height:1.5;margin-bottom:12px;">
        Data syncs automatically between devices in real time. Export/Import remain as a manual backup.
      </p>
      <div style="display:flex;gap:10px;">
        <button class="btn-export" onclick="exportData()">${ICONS.download} Export Data</button>
        <button class="btn-import" onclick="triggerImport()">${ICONS.upload} Import Data</button>
      </div>
    </div>
    <button class="btn-reset" onclick="confirmReset()">Reset All Data to Original</button>
  `;
}

// --- Confirm Reset ---
function confirmReset() {
  showConfirm(
    'Reset All Data',
    'This will discard all your changes and restore the original items from the Excel file. Continue?',
    'Reset',
    () => {
      resetData();
      hideConfirm();
      showToast('Data reset to original');
      renderItemList();
      renderDashboard();
      renderSettings();
      renderAddForm();
      showScreen('search');
    }
  );
}

// --- Utility ---
function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// --- Calibration helpers ---
function parseDateLocal(str) {
  if (!str) return null;
  const parts = String(str).split('-');
  if (parts.length !== 3) return null;
  const y = Number(parts[0]), m = Number(parts[1]), d = Number(parts[2]);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return new Date(y, m - 1, d);
}
function todayStart() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}
function dayDiff(a, b) {
  return Math.round((a - b) / 86400000);
}
// Returns { daysSince, daysUntil, dueSoon } for calibration-tracked items, else null.
// dueSoon = next calibration is within 30 days (or already overdue).
function getCalibrationInfo(item) {
  if (!item || !item.calibration) return null;
  const today = todayStart();
  const last = parseDateLocal(item.lastCalibration);
  const next = parseDateLocal(item.nextCalibration);
  const daysSince = last ? dayDiff(today, last) : null;
  const daysUntil = next ? dayDiff(next, today) : null;
  const dueSoon = daysUntil !== null && daysUntil <= 30;
  return { daysSince, daysUntil, dueSoon };
}
function formatDaysSince(daysSince) {
  if (daysSince === null || daysSince === undefined) return '—';
  return `${daysSince} day${daysSince === 1 ? '' : 's'} since last`;
}
function formatDaysUntil(daysUntil) {
  if (daysUntil === null || daysUntil === undefined) return '—';
  if (daysUntil > 0) return `${daysUntil} day${daysUntil === 1 ? '' : 's'} until next`;
  if (daysUntil === 0) return 'Due today';
  const over = Math.abs(daysUntil);
  return `${over} day${over === 1 ? '' : 's'} overdue`;
}
// Returns the calibration info block HTML for the detail view (empty string if not calibration-tracked).
function renderCalibDetail(item) {
  if (!item || !item.calibration) return '';
  const info = getCalibrationInfo(item);
  const urgent = info.dueSoon;
  return `
    <div class="calib-detail ${urgent ? 'calib-detail--urgent' : ''}">
      <div class="calib-detail-title">
        <span class="calib-detail-dot" style="background:${urgent ? '#EF4444' : 'var(--accent-light)'}"></span>
        Calibration
      </div>
      <div class="calib-detail-row"><span>Last calibrated</span><span>${escapeHtml(item.lastCalibration || '—')} · ${formatDaysSince(info.daysSince)}</span></div>
      <div class="calib-detail-row"><span>Next calibration</span><span class="${urgent ? 'calib-detail-urgent' : ''}">${escapeHtml(item.nextCalibration || '—')} · ${formatDaysUntil(info.daysUntil)}</span></div>
    </div>
  `;
}

// Map a status string to a CSS class suffix for status-colored dots/badges.
// Available stays the default teal/green; other statuses get their own color.
function getStatusClass(status) {
  const s = String(status || 'Available').toLowerCase().replace(/\s+/g, '-');
  const valid = ['available', 'in-use', 'maintenance', 'unavailable', 'lost'];
  return valid.includes(s) ? s : 'available';
}

// --- Setup Confirm Dialog Handlers ---
function setupConfirmHandlers() {
  document.getElementById('confirmCancel').addEventListener('click', hideConfirm);
  document.getElementById('confirmOk').addEventListener('click', () => {
    if (confirmCallback) confirmCallback();
    else hideConfirm();
  });
  document.getElementById('confirmOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'confirmOverlay') hideConfirm();
  });
  document.getElementById('editBackBtn').addEventListener('click', () => {
    if (editingItemId) showDetail(editingItemId);
    else goBack();
  });
  document.getElementById('mapBackBtn').addEventListener('click', () => {
    if (mapReturnScreen === 'search') {
      showScreen('search');
    } else if (mapReturnScreen === 'detail' && mapReturnItemId) {
      showDetail(mapReturnItemId);
    } else if (mapReturnScreen === 'floorplan') {
      showScreen('floorplan');
    } else {
      showScreen('search');
    }
  });
  document.getElementById('floorPlanBackBtn').addEventListener('click', () => {
    showScreen('dashboard');
  });
}

// --- Init ---
function init() {
  loadData();
  setupSyncIndicator();
  setupFilterChips();
  setupSearch();
  setupZoomPrevention();
  setupConfirmHandlers();
  setupSwipeBack();
  setupDateSegAutoAdvance();
  renderItemList();
  renderDashboard();
  renderAddForm();
  renderSettings();
  updateTabBars('search');

  // Firestore bootstrap is async: the UI has already painted from the local cache;
  // real-time sync kicks in when the anonymous session is live.
  initFirebase().then(ok => {
    if (ok) subscribeToItems();
    else setSyncState('offline');
  });
}

document.addEventListener('DOMContentLoaded', init);
