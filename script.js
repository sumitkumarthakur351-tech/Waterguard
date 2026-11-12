/**
 * ====================================================================
 * WaterGuard — Smart Water Quality Monitoring System
 * IoT Web Dashboard Logic & Telemetry Engine
 * ====================================================================
 * 
 * FINAL DATA FLOW:
 * Water Sensors → ESP32 Microcontroller → Wi-Fi → Firebase Realtime DB → WaterGuard Dashboard
 * 
 * This file is modularly structured with:
 * - getSensorData()
 * - updateDashboard()
 * - updateCharts()
 * - checkWaterQuality()
 * 
 * Prepared for plug-and-play Firebase Realtime Database integration.
 */

// ====================================================================
// 🔥 FIREBASE REALTIME DATABASE CONFIGURATION & ACTIVE ENGINE
// ====================================================================

const FIREBASE_CONFIG = {
  databaseURL: "https://waterguard-67705-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "waterguard-67705"
};

let firebaseApp = null;
let firebaseDb = null;
let isFirebaseConnected = false;
let isFirebaseReceivingLive = false;
let sseSource = null;

/**
 * Extracts and normalizes sensor data from various potential JSON structures
 * (handles root level, nested objects, and case variations).
 */
function extractTelemetry(rawData) {
  if (!rawData || typeof rawData !== 'object') return null;

  // Search inside potential parent objects (root, data, sensorData, waterguard, sensors)
  const candidate = rawData.sensorData || rawData.sensors || rawData.waterguard || rawData.data || rawData;

  // Extract keys case-insensitively
  let ph = candidate.ph ?? candidate.pH ?? candidate.PH;
  let tds = candidate.tds ?? candidate.TDS ?? candidate.Tds;
  let turb = candidate.turbidity ?? candidate.turb ?? candidate.TURBIDITY ?? candidate.Turb;
  let temp = candidate.temperature ?? candidate.temp ?? candidate.TEMP ?? candidate.Temperature;

  if (ph !== undefined || tds !== undefined || turb !== undefined || temp !== undefined) {
    return {
      ph: ph !== undefined ? parseFloat(ph) : currentTelemetry.ph,
      tds: tds !== undefined ? parseInt(tds) : currentTelemetry.tds,
      turbidity: turb !== undefined ? parseFloat(turb) : currentTelemetry.turbidity,
      temperature: temp !== undefined ? parseFloat(temp) : currentTelemetry.temperature,
      timestamp: candidate.timestamp ? new Date(candidate.timestamp) : new Date()
    };
  }

  return null;
}

/**
 * Updates UI status for Firebase connection state.
 */
function setFirebaseUIState(state, message) {
  const statusPill = document.getElementById('firebaseStatusPill');
  const statusText = document.getElementById('fbStatusText');
  const banner = document.getElementById('firebaseBanner');
  const bannerTitle = document.getElementById('fbBannerTitle');
  const bannerMsg = document.getElementById('fbBannerMsg');

  if (!statusPill) return;

  if (state === 'live') {
    statusPill.className = 'firebase-status-pill connected';
    if (statusText) statusText.textContent = 'Firebase: Live Stream 🟢';
    if (banner) banner.className = 'firebase-banner';
    if (bannerTitle) bannerTitle.textContent = 'Firebase Realtime Stream: ACTIVE';
    if (bannerMsg) bannerMsg.innerHTML = message || 'Receiving live sensor telemetry packets from ESP32.';
  } else if (state === 'empty') {
    statusPill.className = 'firebase-status-pill';
    if (statusText) statusText.textContent = 'Firebase: Connected (Empty) 🟡';
    if (banner) banner.className = 'firebase-banner warning';
    if (bannerTitle) bannerTitle.textContent = 'Firebase Connected: Database is Empty (null)';
    if (bannerMsg) bannerMsg.innerHTML = 'Database returned null. Push a test packet or send data from your ESP32.';
  } else if (state === 'error' || state === 'unauthorized') {
    statusPill.className = 'firebase-status-pill error';
    if (statusText) statusText.textContent = 'Firebase: Rules Locked (401) 🔴';
    if (banner) banner.className = 'firebase-banner error';
    if (bannerTitle) bannerTitle.textContent = 'Firebase Security Rules Locked (401 Permission Denied)';
    if (bannerMsg) bannerMsg.innerHTML = 'Go to Firebase Console → <strong>Rules</strong> tab → set <code>.read: true</code> and <code>.write: true</code> → click <strong>Publish</strong>.';
  } else {
    statusPill.className = 'firebase-status-pill';
    if (statusText) statusText.textContent = 'Firebase: Connecting...';
  }
}

/**
 * Initializes Firebase Realtime Database Listener.
 * Employs a dual-mode strategy:
 * 1. Official Firebase Compat SDK
 * 2. Realtime SSE EventSource / REST fallback
 */
function initFirebaseConnection() {
  const url = FIREBASE_CONFIG.databaseURL;
  setFirebaseUIState('connecting', 'Connecting to Firebase Realtime Database...');

  // Try official Firebase Compat SDK
  if (typeof firebase !== 'undefined') {
    try {
      if (!firebase.apps.length) {
        firebaseApp = firebase.initializeApp(FIREBASE_CONFIG);
      } else {
        firebaseApp = firebase.app();
      }
      firebaseDb = firebase.database();

      // Listen on root
      firebaseDb.ref('/').on('value', (snapshot) => {
        const val = snapshot.val();
        handleFirebaseDataPayload(val);
      }, (error) => {
        console.warn('Firebase SDK listener error:', error);
        if (error.code === 'PERMISSION_DENIED') {
          setFirebaseUIState('unauthorized');
        }
      });
      isFirebaseConnected = true;
    } catch (err) {
      console.warn('Firebase SDK initialization notice:', err);
    }
  }

  // Also initiate resilient native EventSource stream
  startFirebaseEventSource();
}

/**
 * Handles incoming data from either SDK or SSE stream.
 */
function handleFirebaseDataPayload(val) {
  if (val === null) {
    setFirebaseUIState('empty');
    return;
  }

  const parsed = extractTelemetry(val);
  if (parsed) {
    isFirebaseReceivingLive = true;
    // When real data streams from ESP32, automatically switch off the random mock generator!
    isSimulating = false;
    const simBtnText = document.getElementById('simBtnText');
    if (simBtnText) simBtnText.textContent = 'Live Sim: PAUSED (Firebase Active)';

    currentTelemetry = parsed;
    updateDashboard(currentTelemetry);
    updateCharts();
    setFirebaseUIState('live', `Live ESP32 telemetry received at ${new Date().toLocaleTimeString()}.`);
  } else {
    setFirebaseUIState('connected', 'Connected to Firebase. Waiting for sensor fields (ph, tds, turbidity, temperature).');
  }
}

/**
 * Native EventSource / REST Realtime fallback (Zero-dependency SSE streaming)
 */
function startFirebaseEventSource() {
  const streamUrl = `${FIREBASE_CONFIG.databaseURL}/.json`;

  try {
    if (sseSource) sseSource.close();
    sseSource = new EventSource(streamUrl);

    sseSource.addEventListener('put', (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload && payload.data !== undefined) {
          handleFirebaseDataPayload(payload.data);
        }
      } catch (err) {
        console.error('Error parsing SSE event data:', err);
      }
    });

    sseSource.addEventListener('patch', (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload && payload.data) {
          handleFirebaseDataPayload(payload.data);
        }
      } catch (err) {
        console.error('Error parsing SSE patch data:', err);
      }
    });

    sseSource.onerror = (err) => {
      // Typically fires on 401 Unauthorized or network issues
      checkFirebaseRulesStatus();
    };
  } catch (err) {
    console.warn('EventSource initialization:', err);
  }
}

/**
 * Probes the database endpoint to detect 401 Permission Denied vs OK
 */
async function checkFirebaseRulesStatus() {
  try {
    const res = await fetch(`${FIREBASE_CONFIG.databaseURL}/.json`);
    if (res.status === 401 || res.status === 403) {
      setFirebaseUIState('unauthorized');
    } else if (res.ok) {
      const data = await res.json();
      if (data === null) {
        setFirebaseUIState('empty');
      } else {
        handleFirebaseDataPayload(data);
      }
    }
  } catch (err) {
    console.warn('Firebase probe fetch error:', err);
  }
}

/**
 * Pushes a realistic test packet directly to Firebase so the user can verify
 * real-time writing & reading immediately without waiting for hardware.
 */
async function pushTestReadingToFirebase() {
  const testPacket = {
    ph: parseFloat((7.20 + (Math.random() - 0.5) * 0.2).toFixed(2)),
    tds: Math.floor(310 + (Math.random() - 0.5) * 20),
    turbidity: parseFloat((2.8 + (Math.random() - 0.5) * 0.4).toFixed(1)),
    temperature: parseFloat((26.4 + (Math.random() - 0.5) * 0.8).toFixed(1)),
    lastUpdated: new Date().toLocaleTimeString(),
    device: "ESP32-WaterGuard-Node01"
  };

  try {
    const res = await fetch(`${FIREBASE_CONFIG.databaseURL}/.json`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testPacket)
    });

    if (res.status === 401 || res.status === 403) {
      setFirebaseUIState('unauthorized');
      const modal = document.getElementById('rulesModalBackdrop');
      if (modal) modal.classList.add('active');
      alert('⚠️ Firebase returned 401 Unauthorized!\n\nYour Firebase Realtime Database Rules are currently locked.\nPlease update the Rules to allow read and write (see the guide on screen).');
      return;
    }

    if (res.ok) {
      alert(`✅ Success! Test data written to Firebase!\n\npH: ${testPacket.ph} | TDS: ${testPacket.tds} ppm | Turbidity: ${testPacket.turbidity} NTU | Temp: ${testPacket.temperature} °C\n\nYour dashboard and Firebase Console are now synced.`);
      handleFirebaseDataPayload(testPacket);
    }
  } catch (err) {
    alert(`Could not push to Firebase: ${err.message}`);
  }
}

// ====================================================================
// GLOBAL STATE & TELEMETRY MODEL
// ====================================================================

// Active telemetry packet (Initial default values)
let currentTelemetry = {
  ph: 7.20,
  tds: 310,
  turbidity: 2.8,
  temperature: 26.4,
  timestamp: new Date()
};

// Historical readings buffer for Recent Readings table (most recent first)
let recentReadings = [
  { time: "10:42:15 AM", ph: 7.20, tds: 310, turbidity: 2.8, temp: 26.4, status: "Normal" },
  { time: "10:39:15 AM", ph: 7.18, tds: 312, turbidity: 2.7, temp: 26.3, status: "Normal" },
  { time: "10:36:15 AM", ph: 7.22, tds: 308, turbidity: 2.9, temp: 26.5, status: "Normal" },
  { time: "10:33:15 AM", ph: 7.19, tds: 315, turbidity: 3.1, temp: 26.2, status: "Normal" },
  { time: "10:30:15 AM", ph: 7.15, tds: 318, turbidity: 3.0, temp: 26.4, status: "Normal" },
  { time: "10:27:15 AM", ph: 7.24, tds: 305, turbidity: 2.8, temp: 26.6, status: "Normal" }
];

// Active Alerts array
let activeAlerts = [
  {
    id: 1,
    type: "warning",
    name: "Turbidity Level High",
    time: "10:42 AM",
    value: "18.5 NTU",
    limit: "< 5.0 NTU",
    active: true
  }
];

// Locations metadata
const locations = {
  tank01: {
    title: "Water Tank – Tank 01",
    type: "Storage Reservoir (Indoor)",
    coords: "28.6139° N, 77.2090° E",
    sampling: "Every 3 Seconds"
  },
  tank02: {
    title: "Water Tank – Tank 02",
    type: "Overhead Distribution Tank",
    coords: "28.6145° N, 77.2105° E",
    sampling: "Every 3 Seconds"
  },
  river01: {
    title: "River Basin – Station 01 (Inflow)",
    type: "Open Fluvial Stream (Outdoor)",
    coords: "28.6401° N, 77.2410° E",
    sampling: "Every 5 Seconds"
  },
  river02: {
    title: "River Basin – Station 02 (Delta)",
    type: "Downstream Delta Outflow",
    coords: "28.6520° N, 77.2550° E",
    sampling: "Every 5 Seconds"
  }
};

// Chart.js instance and filter states
let mainTrendsChartInstance = null;
let activeChartParam = 'ph'; // 'ph', 'tds', 'turbidity', 'temperature'
let activeChartTime = '1H';  // '1H', '6H', '24H', '7D'

// Simulation toggle state (for Viva demonstrations)
let isSimulating = true;
let simulationInterval = null;

// ====================================================================
// CORE REQUIRED FUNCTION 1: getSensorData()
// ====================================================================
/**
 * Fetches the latest sensor readings.
 * In production: Reads from Firebase Realtime Database or REST endpoint.
 * In demo mode: Simulates subtle natural sensor variances around baseline.
 * 
 * @returns {Object} { ph, tds, turbidity, temperature, timestamp }
 */
function getSensorData() {
  // If connected to Firebase, this returns the Firebase snapshot payload.
  // For simulation / demonstration, apply small realistic micro-fluctuations:
  const phJitter = (Math.random() - 0.49) * 0.04;
  const tdsJitter = Math.floor((Math.random() - 0.49) * 4);
  const turbJitter = (Math.random() - 0.49) * 0.1;
  const tempJitter = (Math.random() - 0.49) * 0.08;

  currentTelemetry.ph = parseFloat((currentTelemetry.ph + phJitter).toFixed(2));
  currentTelemetry.tds = Math.max(10, currentTelemetry.tds + tdsJitter);
  currentTelemetry.turbidity = parseFloat(Math.max(0.1, currentTelemetry.turbidity + turbJitter).toFixed(2));
  currentTelemetry.temperature = parseFloat((currentTelemetry.temperature + tempJitter).toFixed(1));
  currentTelemetry.timestamp = new Date();

  return currentTelemetry;
}

// ====================================================================
// CORE REQUIRED FUNCTION 2: checkWaterQuality()
// ====================================================================
/**
 * Evaluates sensor readings against standard safe drinking / river thresholds.
 * Thresholds:
 * - pH: Safe 6.5 - 8.5 (Critical < 6.0 or > 9.0; Warning 6.0-6.5 or 8.5-9.0)
 * - TDS: Safe < 500 ppm (Critical > 800; Warning 500-800)
 * - Turbidity: Safe < 5.0 NTU (Critical > 15.0; Warning 5.0-15.0)
 * - Temperature: Safe 20.0 - 30.0 °C (Critical < 15 or > 35; Warning 15-20 or 30-35)
 * 
 * @param {Object} data Sensor reading object
 * @returns {Object} Quality evaluation: { level, wqiScore, description, breaches }
 */
function checkWaterQuality(data) {
  const breaches = [];
  let worstSeverity = 'normal'; // 'normal', 'warning', 'critical'

  // pH Check
  if (data.ph < 6.0 || data.ph > 9.0) {
    worstSeverity = 'critical';
    breaches.push({ param: 'pH', message: `pH extreme: ${data.ph} (Permissible: 6.5 - 8.5)` });
  } else if (data.ph < 6.5 || data.ph > 8.5) {
    if (worstSeverity !== 'critical') worstSeverity = 'warning';
    breaches.push({ param: 'pH', message: `pH borderline: ${data.ph} (Ideal: 6.5 - 8.5)` });
  }

  // TDS Check
  if (data.tds > 800) {
    worstSeverity = 'critical';
    breaches.push({ param: 'TDS', message: `High mineralization: ${data.tds} ppm (Limit: < 500 ppm)` });
  } else if (data.tds > 500) {
    if (worstSeverity !== 'critical') worstSeverity = 'warning';
    breaches.push({ param: 'TDS', message: `Elevated TDS: ${data.tds} ppm (Limit: < 500 ppm)` });
  }

  // Turbidity Check
  if (data.turbidity > 15.0) {
    worstSeverity = 'critical';
    breaches.push({ param: 'Turbidity', message: `Severe turbidity: ${data.turbidity} NTU (Permissible: < 5.0 NTU)` });
  } else if (data.turbidity > 5.0) {
    if (worstSeverity !== 'critical') worstSeverity = 'warning';
    breaches.push({ param: 'Turbidity', message: `Turbidity elevated: ${data.turbidity} NTU (Permissible: < 5.0 NTU)` });
  }

  // Temperature Check
  if (data.temperature < 15.0 || data.temperature > 35.0) {
    if (worstSeverity === 'normal') worstSeverity = 'warning';
    breaches.push({ param: 'Temperature', message: `Abnormal temp: ${data.temperature} °C` });
  }

  // Water Quality Index (WQI) Score Calculation (0-100)
  let wqi = 95;
  if (worstSeverity === 'critical') {
    wqi = Math.max(25, 45 - breaches.length * 8);
  } else if (worstSeverity === 'warning') {
    wqi = Math.max(55, 72 - breaches.length * 5);
  } else {
    // Slight variance near 92-96
    wqi = Math.min(98, Math.max(90, Math.round(96 - (Math.abs(data.ph - 7.0) * 4))));
  }

  let description = "All monitored parameters are within the configured range.";
  if (worstSeverity === 'warning') {
    description = `Warning: ${breaches[0]?.message || 'Parameters nearing safety threshold'}. Inspection recommended.`;
  } else if (worstSeverity === 'critical') {
    description = `Critical Alert: ${breaches[0]?.message || 'Unsafe water quality parameters detected!'} Immediate action required.`;
  }

  return {
    level: worstSeverity.toUpperCase(), // 'NORMAL', 'WARNING', 'CRITICAL'
    rawLevel: worstSeverity,
    wqiScore: wqi,
    description: description,
    breaches: breaches
  };
}

// ====================================================================
// CORE REQUIRED FUNCTION 3: updateDashboard()
// ====================================================================
/**
 * Renders the latest sensor readings, updates the status panel,
 * refreshes badges, sparklines, and recent readings table.
 * 
 * @param {Object} data Sensor reading object
 */
function updateDashboard(data = currentTelemetry) {
  // 1. Update Sensor Card Values
  const phValEl = document.getElementById('phValue');
  const tdsValEl = document.getElementById('tdsValue');
  const turbValEl = document.getElementById('turbValue');
  const tempValEl = document.getElementById('tempValue');

  if (phValEl) phValEl.textContent = data.ph.toFixed(2);
  if (tdsValEl) tdsValEl.textContent = data.tds;
  if (turbValEl) turbValEl.textContent = data.turbidity.toFixed(1);
  if (tempValEl) tempValEl.textContent = data.temperature.toFixed(1);

  // 2. Run Water Quality Diagnostic
  const quality = checkWaterQuality(data);

  // Update Individual Badges
  updateSensorBadge('phBadge', data.ph >= 6.5 && data.ph <= 8.5, data.ph < 6.0 || data.ph > 9.0);
  updateSensorBadge('tdsBadge', data.tds <= 500, data.tds > 800);
  updateSensorBadge('turbBadge', data.turbidity <= 5.0, data.turbidity > 15.0);
  updateSensorBadge('tempBadge', data.temperature >= 20.0 && data.temperature <= 30.0, data.temperature < 15.0 || data.temperature > 35.0);

  // 3. Update Water Quality Status Panel (NORMAL / WARNING / CRITICAL)
  const statusPanel = document.getElementById('waterStatusPanel');
  const statusLevelBadge = document.getElementById('statusLevelBadge');
  const statusDescription = document.getElementById('statusDescription');
  const statusEmoji = document.getElementById('statusEmoji');
  const statusIconRing = document.getElementById('statusIconRing');
  const wqiScore = document.getElementById('wqiScore');
  const wqiFill = document.getElementById('wqiFill');

  if (statusPanel && statusLevelBadge) {
    statusPanel.className = `water-status-panel ${quality.rawLevel}-state`;
    statusLevelBadge.textContent = quality.level;
    statusDescription.textContent = quality.description;

    if (quality.level === 'NORMAL') {
      statusEmoji.textContent = '🟢';
      if (statusIconRing) statusIconRing.style.borderColor = 'rgba(16, 185, 129, 0.4)';
      wqiScore.textContent = `${quality.wqiScore} / 100 — Excellent (Potable)`;
      wqiFill.style.background = 'linear-gradient(90deg, #00F2FE 0%, #10B981 100%)';
    } else if (quality.level === 'WARNING') {
      statusEmoji.textContent = '🟡';
      if (statusIconRing) statusIconRing.style.borderColor = 'rgba(245, 158, 11, 0.5)';
      wqiScore.textContent = `${quality.wqiScore} / 100 — Fair (Filtration Advised)`;
      wqiFill.style.background = 'linear-gradient(90deg, #F59E0B 0%, #D97706 100%)';
    } else {
      statusEmoji.textContent = '🔴';
      if (statusIconRing) statusIconRing.style.borderColor = 'rgba(239, 68, 68, 0.6)';
      wqiScore.textContent = `${quality.wqiScore} / 100 — Poor (Unsafe / Contaminated)`;
      wqiFill.style.background = 'linear-gradient(90deg, #EF4444 0%, #DC2626 100%)';
    }
    wqiFill.style.width = `${quality.wqiScore}%`;
  }

  // 4. Update "Last Updated" Timestamp
  const now = data.timestamp || new Date();
  const timeString = now.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const lastUpdatedEl = document.getElementById('lastUpdatedText');
  if (lastUpdatedEl) {
    lastUpdatedEl.textContent = `Last Updated: ${timeString}`;
  }

  // 5. Manage Dynamic Alerts List
  syncAlertsWithQuality(quality, data, timeString);

  // 6. Push to Recent Readings Table
  pushToReadingsTable(timeString, data, quality.level);

  // 7. Update Sparklines on sensor cards
  renderSparklines();
}

/**
 * Helper to update individual card status badges
 */
function updateSensorBadge(badgeId, isNormal, isCritical) {
  const el = document.getElementById(badgeId);
  if (!el) return;

  if (isCritical) {
    el.className = 'status-badge critical';
    el.textContent = 'Critical';
  } else if (!isNormal) {
    el.className = 'status-badge warning';
    el.textContent = 'Warning';
  } else {
    el.className = 'status-badge normal';
    el.textContent = 'Normal';
  }
}

/**
 * Sync alerts list based on breaches
 */
function syncAlertsWithQuality(quality, data, timeString) {
  const alertsList = document.getElementById('alertsList');
  const navAlertCount = document.getElementById('navAlertCount');
  if (!alertsList) return;

  if (quality.breaches.length > 0) {
    // Format breaches as alerts
    activeAlerts = quality.breaches.map((b, index) => ({
      id: index + 1,
      type: quality.rawLevel,
      name: `${b.param} Threshold Exceeded`,
      time: timeString.split(' ')[0] + ' ' + timeString.split(' ')[1],
      value: `${data[b.param.toLowerCase()] || ''}`,
      limit: b.message,
      active: true
    }));
  } else {
    activeAlerts = [];
  }

  if (navAlertCount) {
    navAlertCount.textContent = activeAlerts.length;
    navAlertCount.style.display = activeAlerts.length > 0 ? 'inline-block' : 'none';
  }

  renderAlertsList();
}

/**
 * Renders the alerts container (or empty state)
 */
function renderAlertsList() {
  const alertsList = document.getElementById('alertsList');
  if (!alertsList) return;

  if (activeAlerts.length === 0) {
    alertsList.innerHTML = `
      <div class="empty-alerts">
        <div class="empty-alerts-icon">✓</div>
        <div class="empty-alerts-text">No Active Alerts</div>
        <div class="empty-alerts-sub">All monitored parameters are within safe operating limits.</div>
      </div>
    `;
    return;
  }

  alertsList.innerHTML = activeAlerts.map(alert => `
    <div class="alert-item ${alert.type}">
      <div class="alert-icon-wrap">${alert.type === 'critical' ? '🛑' : '⚠'}</div>
      <div class="alert-info">
        <div class="alert-headline">
          <span class="alert-name">${alert.name}</span>
          <span class="alert-time">${alert.time}</span>
        </div>
        <div class="alert-body">
          Current status: <strong class="alert-highlight">${alert.limit}</strong>
        </div>
      </div>
    </div>
  `).join('');
}

/**
 * Prepends a new entry to the Recent Readings table
 */
function pushToReadingsTable(timeString, data, status) {
  const tbody = document.getElementById('readingsTableBody');
  if (!tbody) return;

  // Insert newest at top, keep max 6
  recentReadings.unshift({
    time: timeString,
    ph: data.ph.toFixed(2),
    tds: data.tds,
    turbidity: data.turbidity.toFixed(1),
    temp: data.temperature.toFixed(1),
    status: status
  });

  if (recentReadings.length > 6) {
    recentReadings.pop();
  }

  tbody.innerHTML = recentReadings.map(row => {
    const chipClass = row.status.toLowerCase();
    return `
      <tr>
        <td><strong>${row.time}</strong></td>
        <td>${row.ph}</td>
        <td>${row.tds} ppm</td>
        <td>${row.turbidity} NTU</td>
        <td>${row.temp} °C</td>
        <td><span class="status-chip ${chipClass}">${row.status}</span></td>
      </tr>
    `;
  }).join('');
}

// ====================================================================
// CORE REQUIRED FUNCTION 4: updateCharts()
// ====================================================================
/**
 * Redraws and updates the Chart.js telemetry trends graph
 * based on selected parameter (pH, TDS, Turbidity, Temperature)
 * and time period (1H, 6H, 24H, 7D).
 * 
 * @param {string} param Metric key: 'ph' | 'tds' | 'turbidity' | 'temperature'
 * @param {string} timeRange Range key: '1H' | '6H' | '24H' | '7D'
 */
function updateCharts(param = activeChartParam, timeRange = activeChartTime) {
  activeChartParam = param;
  activeChartTime = timeRange;

  const canvas = document.getElementById('mainTrendsChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // Generate realistic dataset based on param & range
  const { labels, dataPoints, unit, safeRange, color, metaName } = generateHistoricalData(param, timeRange);

  // Calculate statistics (Peak, Low, Average)
  const peak = Math.max(...dataPoints);
  const low = Math.min(...dataPoints);
  const avg = (dataPoints.reduce((a, b) => a + b, 0) / dataPoints.length).toFixed(param === 'tds' ? 0 : 2);

  // Update stats bar below chart
  const statMetricEl = document.getElementById('chartStatMetric');
  const statPeakEl = document.getElementById('chartStatPeak');
  const statLowEl = document.getElementById('chartStatLow');
  const statAvgEl = document.getElementById('chartStatAvg');

  if (statMetricEl) statMetricEl.textContent = `${metaName} (${unit})`;
  if (statPeakEl) statPeakEl.textContent = `${peak} ${unit}`;
  if (statLowEl) statLowEl.textContent = `${low} ${unit}`;
  if (statAvgEl) statAvgEl.textContent = `${avg} ${unit}`;

  // Gradient fill for sleek visual look
  const gradient = ctx.createLinearGradient(0, 0, 0, 300);
  gradient.addColorStop(0, color.gradientStart);
  gradient.addColorStop(1, color.gradientEnd);

  // If chart already exists, destroy and re-create to keep memory clean
  if (mainTrendsChartInstance) {
    mainTrendsChartInstance.destroy();
  }

  mainTrendsChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: `${metaName} (${unit})`,
          data: dataPoints,
          borderColor: color.stroke,
          borderWidth: 2.5,
          pointBackgroundColor: color.stroke,
          pointBorderColor: '#070D19',
          pointBorderWidth: 2,
          pointRadius: labels.length > 20 ? 1 : 4,
          pointHoverRadius: 6,
          fill: true,
          backgroundColor: gradient,
          tension: 0.38
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(10, 18, 36, 0.95)',
          titleColor: '#00F2FE',
          bodyColor: '#FFFFFF',
          borderColor: 'rgba(0, 242, 254, 0.3)',
          borderWidth: 1,
          padding: 12,
          displayColors: false,
          callbacks: {
            label: function(context) {
              return `${context.parsed.y} ${unit} — ${safeRange}`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            color: 'rgba(148, 163, 184, 0.06)',
            borderColor: 'rgba(148, 163, 184, 0.1)'
          },
          ticks: {
            color: '#64748B',
            font: { size: 11, family: "'Plus Jakarta Sans', sans-serif" },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 8
          }
        },
        y: {
          grid: {
            color: 'rgba(148, 163, 184, 0.06)',
            borderColor: 'rgba(148, 163, 184, 0.1)'
          },
          ticks: {
            color: '#64748B',
            font: { size: 11, family: "'Plus Jakarta Sans', sans-serif" },
            callback: function(val) {
              return val + ' ' + (unit === '°C' ? '°' : '');
            }
          }
        }
      }
    }
  });
}

/**
 * Generates realistic curve historical telemetry for charts
 */
function generateHistoricalData(param, timeRange) {
  let count = 12;
  let labels = [];

  // Generate labels based on time range
  if (timeRange === '1H') {
    count = 12;
    for (let i = 11; i >= 0; i--) {
      labels.push(`${i * 5}m ago`);
    }
    labels[labels.length - 1] = "Now";
  } else if (timeRange === '6H') {
    count = 12;
    for (let i = 11; i >= 0; i--) {
      labels.push(`${(i * 0.5).toFixed(1)}h ago`);
    }
    labels[labels.length - 1] = "Now";
  } else if (timeRange === '24H') {
    count = 12;
    for (let i = 11; i >= 0; i--) {
      labels.push(`${i * 2}h ago`);
    }
    labels[labels.length - 1] = "Now";
  } else { // 7D
    count = 7;
    labels = ["Day 1", "Day 2", "Day 3", "Day 4", "Day 5", "Day 6", "Today"];
  }

  let dataPoints = [];
  let unit = "";
  let safeRange = "";
  let metaName = "";
  let color = {
    stroke: '#00F2FE',
    gradientStart: 'rgba(0, 242, 254, 0.35)',
    gradientEnd: 'rgba(0, 242, 254, 0.0)'
  };

  switch (param) {
    case 'ph':
      metaName = "pH Level";
      unit = "pH";
      safeRange = "Safe: 6.5 - 8.5";
      color = { stroke: '#00F2FE', gradientStart: 'rgba(0, 242, 254, 0.32)', gradientEnd: 'rgba(0, 242, 254, 0.0)' };
      dataPoints = generateSmoothSeries(count, 7.18, 0.12, 2);
      break;
    case 'tds':
      metaName = "Total Dissolved Solids";
      unit = "ppm";
      safeRange = "Safe: < 500 ppm";
      color = { stroke: '#C084FC', gradientStart: 'rgba(192, 132, 252, 0.32)', gradientEnd: 'rgba(192, 132, 252, 0.0)' };
      dataPoints = generateSmoothSeries(count, 312, 15, 0);
      break;
    case 'turbidity':
      metaName = "Turbidity";
      unit = "NTU";
      safeRange = "Safe: < 5.0 NTU";
      color = { stroke: '#FBBF24', gradientStart: 'rgba(251, 191, 36, 0.32)', gradientEnd: 'rgba(251, 191, 36, 0.0)' };
      dataPoints = generateSmoothSeries(count, 2.7, 0.4, 2);
      break;
    case 'temperature':
      metaName = "Water Temperature";
      unit = "°C";
      safeRange = "Safe: 20 - 30 °C";
      color = { stroke: '#F87171', gradientStart: 'rgba(248, 113, 113, 0.32)', gradientEnd: 'rgba(248, 113, 113, 0.0)' };
      dataPoints = generateSmoothSeries(count, 26.3, 0.6, 1);
      break;
  }

  // Force latest point to match currentTelemetry
  if (dataPoints.length > 0) {
    dataPoints[dataPoints.length - 1] = currentTelemetry[param];
  }

  return { labels, dataPoints, unit, safeRange, color, metaName };
}

/**
 * Creates realistic smooth random walk time series
 */
function generateSmoothSeries(count, baseline, variance, decimals) {
  let arr = [];
  let current = baseline;
  for (let i = 0; i < count; i++) {
    const delta = (Math.random() - 0.5) * variance;
    current = +(current + delta).toFixed(decimals);
    arr.push(current);
  }
  return arr;
}

// ====================================================================
// SPARKLINES RENDERER (HTML5 CANVAS FOR SENSOR CARDS)
// ====================================================================
function renderSparklines() {
  drawSparkline('sparkline-ph', [7.1, 7.15, 7.18, 7.22, 7.19, 7.21, currentTelemetry.ph], '#00F2FE');
  drawSparkline('sparkline-tds', [320, 318, 315, 312, 314, 311, currentTelemetry.tds], '#C084FC');
  drawSparkline('sparkline-turb', [2.5, 2.7, 2.6, 3.0, 2.8, 2.9, currentTelemetry.turbidity], '#FBBF24');
  drawSparkline('sparkline-temp', [26.1, 26.2, 26.3, 26.5, 26.4, 26.5, currentTelemetry.temperature], '#F87171');
}

function drawSparkline(canvasId, points, strokeColor) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const width = canvas.offsetWidth || 200;
  const height = canvas.offsetHeight || 42;
  canvas.width = width;
  canvas.height = height;

  const min = Math.min(...points);
  const max = Math.max(...points) || min + 1;
  const range = max - min || 1;
  const step = width / (points.length - 1);

  ctx.clearRect(0, 0, width, height);

  // Gradient area
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, strokeColor + '40');
  gradient.addColorStop(1, strokeColor + '00');

  ctx.beginPath();
  points.forEach((val, i) => {
    const x = i * step;
    const y = height - ((val - min) / range) * (height - 10) - 5;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });

  // Stroke line
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Fill below line
  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();
}

// ====================================================================
// VIVA PRESENTATION PRESET SIMULATOR
// ====================================================================
/**
 * Allows the student to easily trigger preset condition states
 * (Normal, Warning, Critical) during their project defense.
 */
window.setPresetCondition = function(preset) {
  // Update sim pill active class
  document.querySelectorAll('.sim-pill').forEach(btn => btn.classList.remove('active'));
  const targetBtn = document.querySelector(`.sim-${preset.substring(0, 4)}`);
  if (targetBtn) targetBtn.classList.add('active');

  if (preset === 'normal') {
    currentTelemetry = {
      ph: 7.20,
      tds: 310,
      turbidity: 2.8,
      temperature: 26.4,
      timestamp: new Date()
    };
  } else if (preset === 'warning') {
    currentTelemetry = {
      ph: 8.65, // slightly alkaline
      tds: 560, // elevated TDS
      turbidity: 6.2, // slightly cloudy
      temperature: 28.1,
      timestamp: new Date()
    };
  } else if (preset === 'critical') {
    currentTelemetry = {
      ph: 5.4,  // Acidic contamination
      tds: 890, // Unsafe solids
      turbidity: 18.5, // High particulate/mud
      temperature: 33.2,
      timestamp: new Date()
    };
  }

  updateDashboard(currentTelemetry);
  updateCharts();
};

// ====================================================================
// EVENT LISTENERS & INITIALIZATION
// ====================================================================
document.addEventListener('DOMContentLoaded', () => {
  // 1. Live Clock & Date ticker
  function updateClock() {
    const now = new Date();
    const dateEl = document.getElementById('currentDate');
    const timeEl = document.getElementById('currentTime');

    if (dateEl) {
      dateEl.textContent = now.toLocaleDateString('en-US', {
        month: 'short',
        day: '2-digit',
        year: 'numeric'
      });
    }

    if (timeEl) {
      timeEl.textContent = now.toLocaleTimeString('en-US', {
        hour12: true,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    }
  }
  updateClock();
  setInterval(updateClock, 1000);

  // 2. Initial Dashboard & Chart Render
  updateDashboard(currentTelemetry);
  updateCharts(activeChartParam, activeChartTime);

  // 3. Periodic Telemetry Loop (Simulating Live ESP32 packets every 3s)
  function startSimulation() {
    if (simulationInterval) clearInterval(simulationInterval);
    simulationInterval = setInterval(() => {
      if (isSimulating) {
        const newData = getSensorData();
        updateDashboard(newData);
      }
    }, 3000);
  }
  startSimulation();

  // 4. Toggle Simulation Button Handler
  const simBtn = document.getElementById('btnSimulate');
  const simBtnText = document.getElementById('simBtnText');
  if (simBtn) {
    simBtn.addEventListener('click', () => {
      isSimulating = !isSimulating;
      if (simBtnText) {
        simBtnText.textContent = isSimulating ? 'Live Sim: ON' : 'Live Sim: OFF';
      }
      simBtn.style.opacity = isSimulating ? '1' : '0.6';
    });
  }

  // 5. Chart Parameter Switcher Buttons (pH, TDS, Turbidity, Temperature)
  document.querySelectorAll('.param-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.param-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      const param = e.target.getAttribute('data-param');
      updateCharts(param, activeChartTime);
    });
  });

  // 6. Chart Time Filter Buttons (1H, 6H, 24H, 7D)
  document.querySelectorAll('.time-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      const range = e.target.getAttribute('data-time');
      updateCharts(activeChartParam, range);
    });
  });

  // 7. Location Selector & Switcher
  const locSelect = document.getElementById('locationSelector');
  const locTitle = document.getElementById('locDisplayTitle');
  const locType = document.getElementById('locDeployType');
  const locCoords = document.getElementById('locCoordinates');
  const switchSiteBtn = document.getElementById('switchSiteBtn');

  function applyLocation(locKey) {
    const loc = locations[locKey] || locations.tank01;
    if (locTitle) locTitle.textContent = loc.title;
    if (locType) locType.textContent = loc.type;
    if (locCoords) locCoords.textContent = loc.coords;
    if (locSelect) locSelect.value = locKey;
  }

  if (locSelect) {
    locSelect.addEventListener('change', (e) => {
      applyLocation(e.target.value);
    });
  }

  if (switchSiteBtn) {
    switchSiteBtn.addEventListener('click', () => {
      const current = locSelect ? locSelect.value : 'tank01';
      const next = (current === 'tank01' || current === 'tank02') ? 'river01' : 'tank01';
      applyLocation(next);
    });
  }

  // 8. Clear Alerts Button
  const clearAlertsBtn = document.getElementById('clearAlertsBtn');
  if (clearAlertsBtn) {
    clearAlertsBtn.addEventListener('click', () => {
      activeAlerts = [];
      const navAlertCount = document.getElementById('navAlertCount');
      if (navAlertCount) navAlertCount.style.display = 'none';
      renderAlertsList();
    });
  }

  // 9. Mobile Sidebar Toggle & Backdrop
  const mobileToggleBtn = document.getElementById('mobileToggleBtn');
  const mobileCloseBtn = document.getElementById('mobileCloseBtn');
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebarBackdrop');

  function openSidebar() {
    if (sidebar) sidebar.classList.add('open');
    if (backdrop) backdrop.classList.add('active');
  }

  function closeSidebar() {
    if (sidebar) sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('active');
  }

  if (mobileToggleBtn) mobileToggleBtn.addEventListener('click', openSidebar);
  if (mobileCloseBtn) mobileCloseBtn.addEventListener('click', closeSidebar);
  if (backdrop) backdrop.addEventListener('click', closeSidebar);

  // 10. Window resize re-draw sparklines
  window.addEventListener('resize', () => {
    renderSparklines();
  });

  // 11. Initialize Live Firebase Realtime Database
  initFirebaseConnection();

  // 12. Firebase Action Buttons
  const fbTestPushBtn = document.getElementById('fbTestPushBtn');
  if (fbTestPushBtn) {
    fbTestPushBtn.addEventListener('click', () => {
      pushTestReadingToFirebase();
    });
  }

  // 13. Firebase Rules Guide Modal Handlers
  const fbRulesHelpBtn = document.getElementById('fbRulesHelpBtn');
  const rulesModalBackdrop = document.getElementById('rulesModalBackdrop');
  const modalCloseBtn = document.getElementById('modalCloseBtn');
  const copyRulesBtn = document.getElementById('copyRulesBtn');

  if (fbRulesHelpBtn && rulesModalBackdrop) {
    fbRulesHelpBtn.addEventListener('click', () => {
      rulesModalBackdrop.classList.add('active');
    });
  }

  if (modalCloseBtn && rulesModalBackdrop) {
    modalCloseBtn.addEventListener('click', () => {
      rulesModalBackdrop.classList.remove('active');
    });
  }

  if (rulesModalBackdrop) {
    rulesModalBackdrop.addEventListener('click', (e) => {
      if (e.target === rulesModalBackdrop) {
        rulesModalBackdrop.classList.remove('active');
      }
    });
  }

  if (copyRulesBtn) {
    copyRulesBtn.addEventListener('click', () => {
      const rulesJson = '{\n  "rules": {\n    ".read": true,\n    ".write": true\n  }\n}';
      navigator.clipboard.writeText(rulesJson).then(() => {
        const originalText = copyRulesBtn.textContent;
        copyRulesBtn.textContent = '✓ Copied!';
        setTimeout(() => {
          copyRulesBtn.textContent = originalText;
        }, 2000);
      }).catch(err => {
        alert('Could not auto-copy, please select and copy the text manually.');
      });
    });
  }
});

