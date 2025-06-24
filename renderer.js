// renderer.js - Main UI logic for CS-Assets Storage Scanner

// DOM Elements
const elements = {
  // Views
  loginView: document.getElementById('login-view'),
  dashboardView: document.getElementById('dashboard-view'),
  
  // Forms
  loginForm: document.getElementById('login-form'),
  usernameInput: document.getElementById('username'),
  passwordInput: document.getElementById('password'),
  
  // Account elements
  savedAccountsList: document.getElementById('saved-accounts-list'),
  displayUsername: document.getElementById('display-username'),
  userAvatar: document.getElementById('user-avatar'),
  
  // Storage elements
  storageGrid: document.getElementById('storage-grid'),
  
  // Loading indicator
  loadingIndicator: document.getElementById('loading-indicator'),
  progressBar: document.getElementById('progress-bar'),
  progressText: document.getElementById('progress-text'),
  
  // Modals
  steamGuardModal: document.getElementById('steam-guard-modal'),
  steamGuardInput: document.getElementById('steam-guard-input'),
  device2faModal: document.getElementById('device-2fa-modal'),
  device2faInput: document.getElementById('device-2fa-input'),
  accountNotRegisteredModal: document.getElementById('account-not-registered-modal'),
  notRegisteredAccountName: document.getElementById('not-registered-account-name'),
  warningModal: document.getElementById('warning-modal'),
  warningMessage: document.getElementById('warning-message'),
  scanResultModal: document.getElementById('scan-result-modal'),
  scanResultTitle: document.getElementById('scan-result-title'),
  scanResultSummary: document.getElementById('scan-result-summary'),
  scanResultList: document.getElementById('scan-result-list'),
  inventoryFullModal: document.getElementById('inventory-full-modal'),
  moveItemsModal: document.getElementById('move-items-modal'),
  moveItemsText: document.getElementById('move-items-text')
};

// Global state
const appState = {
  currentUser: null,
  currentCasketName: '',
  inventoryNeedsPayload: null,
  isLoading: false
};



// Update-related state
const updateState = {
  updateAvailable: false,
  downloading: false,
  downloaded: false,
  currentVersion: null
};


// Toast notification system
const toast = {
  container: document.getElementById('toast-container'),
  
  show(message, type = 'info', duration = 3000) {
    const toastEl = document.createElement('div');
    toastEl.className = `toast toast-${type}`;
    
    let iconClass = 'info-circle';
    if (type === 'success') iconClass = 'check-circle';
    if (type === 'error') iconClass = 'exclamation-circle';
    if (type === 'warning') iconClass = 'exclamation-triangle';
    
    toastEl.innerHTML = `
      <div class="toast-content">
        <div class="toast-title">${type.charAt(0).toUpperCase() + type.slice(1)}</div>
        <div class="toast-message">${message}</div>
      </div>
      <button class="toast-close">&times;</button>
    `;
    
    this.container.appendChild(toastEl);
    
    // Handle close button
    const closeBtn = toastEl.querySelector('.toast-close');
    closeBtn.addEventListener('click', () => {
      toastEl.classList.add('toast-hiding');
      setTimeout(() => {
        this.container.removeChild(toastEl);
      }, 300);
    });
    
    // Auto remove after duration
    setTimeout(() => {
      if (toastEl.parentNode === this.container) {
        toastEl.classList.add('toast-hiding');
        setTimeout(() => {
          if (toastEl.parentNode === this.container) {
            this.container.removeChild(toastEl);
          }
        }, 300);
      }
    }, duration);
  },
  
  success(message, duration) {
    this.show(message, 'success', duration);
  },
  
  error(message, duration) {
    this.show(message, 'error', duration);
  },
  
  warning(message, duration) {
    this.show(message, 'warning', duration);
  }
};

// Logger - Log to console but not to UI
const logger = {
  log(message) {
    console.log(`[LOG] ${message}`);
  },
  
  error(message, error) {
    console.error(`[ERROR] ${message}`, error);
  },
  
  warn(message) {
    console.warn(`[WARN] ${message}`);
  }
};

// UI state management
function showView(viewName) {
  // Hide all views
  elements.loginView.style.display = 'none';
  elements.dashboardView.style.display = 'none';
  
  // Show the requested view
  if (viewName === 'login') {
    elements.loginView.style.display = 'block';
    loadSavedAccounts(); // Refresh the accounts list
  } else if (viewName === 'dashboard') {
    elements.dashboardView.style.display = 'block';
    window.electronAPI.fetchStorage();
  }
}







// Create update notification UI
function createUpdateNotification() {
  const updateNotification = document.createElement('div');
  updateNotification.id = 'update-notification';
  updateNotification.className = 'update-notification';
  updateNotification.innerHTML = `
    <div class="update-content">
      <div class="update-icon">🔄</div>
      <div class="update-text">
        <div class="update-title">Update Available</div>
        <div class="update-message">A new version is available</div>
      </div>
      <div class="update-actions">
        <button id="download-update-btn" class="btn btn-primary btn-sm">Download</button>
        <button id="dismiss-update-btn" class="btn btn-secondary btn-sm">Later</button>
      </div>
    </div>
    <div class="update-progress" id="update-progress" style="display: none;">
      <div class="progress-bar" id="update-progress-bar"></div>
      <div class="progress-text" id="update-progress-text">Downloading...</div>
    </div>
  `;
  
  document.body.appendChild(updateNotification);
  
  // Event listeners
  document.getElementById('download-update-btn').addEventListener('click', downloadUpdate);
  document.getElementById('dismiss-update-btn').addEventListener('click', dismissUpdate);
  
  return updateNotification;
}

// Show update available notification
function showUpdateNotification(info) {
  let notification = document.getElementById('update-notification');
  if (!notification) {
    notification = createUpdateNotification();
  }
  
  const messageEl = notification.querySelector('.update-message');
  messageEl.textContent = `Version ${info.version} is available`;
  
  notification.style.display = 'block';
  setTimeout(() => notification.classList.add('show'), 100);
}

// Download update
async function downloadUpdate() {
  const btn = document.getElementById('download-update-btn');
  const progressEl = document.getElementById('update-progress');
  
  btn.disabled = true;
  btn.textContent = 'Downloading...';
  progressEl.style.display = 'block';
  
  updateState.downloading = true;
  
  try {
    const result = await window.electronAPI.downloadUpdate();
    if (!result.success) {
      throw new Error(result.error);
    }
  } catch (error) {
    logger.error('Failed to download update:', error);
    toast.error('Failed to download update: ' + error.message);
    
    btn.disabled = false;
    btn.textContent = 'Download';
    progressEl.style.display = 'none';
    updateState.downloading = false;
  }
}

// Dismiss update notification
function dismissUpdate() {
  const notification = document.getElementById('update-notification');
  if (notification) {
    notification.classList.remove('show');
    setTimeout(() => {
      notification.style.display = 'none';
    }, 300);
  }
}

// Install update
async function installUpdate() {
  try {
    await window.electronAPI.installUpdate();
  } catch (error) {
    logger.error('Failed to install update:', error);
    toast.error('Failed to install update: ' + error.message);
  }
}

// Handle download progress
function handleDownloadProgress(progress) {
  const progressBar = document.getElementById('update-progress-bar');
  const progressText = document.getElementById('update-progress-text');
  
  if (progressBar && progressText) {
    progressBar.style.width = `${progress.percent}%`;
    progressText.textContent = `Downloading... ${Math.round(progress.percent)}%`;
  }
}

// Handle update downloaded
function handleUpdateDownloaded(info) {
  const notification = document.getElementById('update-notification');
  if (notification) {
    notification.innerHTML = `
      <div class="update-content">
        <div class="update-icon">✅</div>
        <div class="update-text">
          <div class="update-title">Update Ready</div>
          <div class="update-message">Version ${info.version} has been downloaded</div>
        </div>
        <div class="update-actions">
          <button id="install-update-btn" class="btn btn-success btn-sm">Restart & Install</button>
          <button id="install-later-btn" class="btn btn-secondary btn-sm">Install Later</button>
        </div>
      </div>
    `;
    
    document.getElementById('install-update-btn').addEventListener('click', installUpdate);
    document.getElementById('install-later-btn').addEventListener('click', dismissUpdate);
  }
  
  updateState.downloaded = true;
  updateState.downloading = false;
}
















// Loading indicator functions
function showLoading(withProgress = false) {
  appState.isLoading = true;
  elements.loadingIndicator.style.display = 'flex';
  
  if (withProgress) {
    elements.progressBar.style.width = '0%';
    elements.progressText.textContent = '0%';
    elements.progressBar.parentElement.style.display = 'block';
  } else {
    elements.progressBar.parentElement.style.display = 'none';
  }
}

function hideLoading() {
  appState.isLoading = false;
  elements.loadingIndicator.style.display = 'none';
}

function updateLoadingProgress(progress, current, total) {
  if (!appState.isLoading) return;
  
  elements.progressBar.style.width = `${progress}%`;
  elements.progressText.textContent = `Processing ${current} / ${total} (${progress}%)`;
}

// Modal management
function showModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.style.display = 'flex';
    
    // Focus the first input if there is one
    const firstInput = modal.querySelector('input');
    if (firstInput) {
      setTimeout(() => {
        firstInput.focus();
      }, 100);
    }
  }
}

function hideModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.style.display = 'none';
  }
}

// Account management
async function loadSavedAccounts() {
  try {
    const accounts = await window.electronAPI.getSavedAccounts();
    elements.savedAccountsList.innerHTML = '';
    
    if (!accounts || accounts.length === 0) {
      elements.savedAccountsList.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-text">No saved accounts found</div>
        </div>
      `;
      return;
    }
    
    // Sort accounts: valid refresh tokens first, then by last used date
    const sortedAccounts = accounts.sort((a, b) => {
      const aHasToken = a.refreshToken && a.refreshToken.trim() !== '';
      const bHasToken = b.refreshToken && b.refreshToken.trim() !== '';
      
      if (aHasToken !== bHasToken) {
        return aHasToken ? -1 : 1; // Accounts with tokens come first
      }
      
      // Then sort by last used (most recent first)
      return (b.lastUsed || 0) - (a.lastUsed || 0);
    });
    
    // For each account, create a new account item
    sortedAccounts.forEach((account) => {
      const div = document.createElement('div');
      div.classList.add('account-item');
      
      // Visual indication if account has no valid token
      const hasToken = account.refreshToken && account.refreshToken.trim() !== '';
      if (!hasToken) {
        div.classList.add('no-token');
      }
      
      div.onclick = () => {
        if (hasToken) {
          // If it has a token, try to log in automatically
          loginWithSavedAccount(account.steamId);
        } else {
          // No token - show credential login form with username pre-filled
          elements.usernameInput.value = account.displayName || '';
          elements.passwordInput.focus();
        }
      };
      
      const lastLogin = account.lastUsed 
        ? new Date(account.lastUsed).toLocaleString() 
        : 'Never';
      
      div.innerHTML = `
        <div class="account-avatar">
          <img src="${account.avatarUrl || 'static/images/default-avatar.png'}" alt="Account avatar">
        </div>
        <div class="account-info">
          <div class="account-name">${account.displayName || account.steamId}</div>
          <div class="account-details">
            ${hasToken ? 'Auto login available' : 'Manual login required'}
            ${account.lastUsed ? ` • Last login: ${lastLogin}` : ''}
          </div>
        </div>
      `;
      
      elements.savedAccountsList.appendChild(div);
    });
  } catch (err) {
    logger.error('Failed to load saved accounts', err);
    elements.savedAccountsList.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-text">Failed to load accounts</div>
      </div>
    `;
  }
}

function loginWithSavedAccount(steamId) {
  logger.log(`Logging in with saved account: ${steamId}`);
  showLoading();
  window.electronAPI.loginWithSavedAccount(steamId);
}

// Login functionality
function handleLogin(event) {
  if (event) event.preventDefault();
  
  const username = elements.usernameInput.value.trim();
  const password = elements.passwordInput.value;
  
  if (!username || !password) {
    toast.warning('Please enter both username and password');
    return;
  }
  
  logger.log(`Logging in with username: ${username}`);
  showLoading();
  window.electronAPI.login({ username, password });
}

// Steam Guard handling
function submitSteamGuardCode() {
  const code = elements.steamGuardInput.value.trim();
  
  if (!code) {
    toast.warning('Please enter the Steam Guard code');
    return;
  }
  
  logger.log('Submitting Steam Guard code');
  window.electronAPI.sendSteamGuardCode(code);
  elements.steamGuardInput.value = '';
  hideModal('steam-guard-modal');
}

// 2FA handling
function submitDevice2FACode() {
  const code = elements.device2faInput.value.trim();
  
  if (!code) {
    toast.warning('Please enter the 2FA code');
    return;
  }
  
  logger.log('Submitting 2FA code');
  window.electronAPI.send2FACode(code);
  elements.device2faInput.value = '';
  hideModal('device-2fa-modal');
}

// Storage units rendering
function renderStorageUnits(caskets) {
  elements.storageGrid.innerHTML = '';
  
  if (!caskets || caskets.length === 0) {
    elements.storageGrid.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-text">No storage units found</div>
        <p>You don't have any storage units in your inventory.</p>
      </div>
    `;
    return;
  }
  
  caskets.forEach((casket) => {
    const unitDiv = document.createElement('div');
    unitDiv.className = 'storage-unit';
    
    // Default CS:GO storage unit icon
    const unitIconUrl = "https://steamcommunity-a.akamaihd.net/economy/image/" +
      "-9a81dlWLwJ2UUGcVs_nsVtzdOEdtWwKGZZLQHTxDZ7I56KU0Zwwo4NUX4oFJZEHLbXX7gNTPcUxqAhWSVieFOX71szWCgwsdlZRsuz0L1M1iqrOIGUauNiyzdmKxKWsMrnXkjlQsIthhO5eh9dfdg";
    
    unitDiv.onclick = () => {
      startDeepCheck(casket.casketId, casket.casketName, unitDiv);
    };
    
    unitDiv.innerHTML = `
      <img src="${unitIconUrl}" alt="${casket.casketName}">
      <div class="storage-name">${casket.casketName}</div>
      <div class="storage-items">Contains ${casket.itemCount} item(s)</div>
    `;
    
    elements.storageGrid.appendChild(unitDiv);
  });
}

// Deep check functionality
function startDeepCheck(casketId, casketName, unitElement) {
  appState.currentCasketName = casketName;
  
  // Disable the element to prevent multiple clicks
  if (unitElement) {
    unitElement.style.pointerEvents = 'none';
  }
  
  showLoading(true);
  logger.log(`Starting deep check on storage unit: ${casketName} (${casketId})`);
  window.electronAPI.deepCheckCasket(casketId);
}

// Handle deep check result
function handleDeepCheckResult(data) {
  hideLoading();
  
  if (!data.success) {
    if (data.error && data.error.includes('Weder Inventar noch Casket haben genug Platz. Abbruch.')) {
      showModal('inventory-full-modal');
    } else {
      toast.error(`Deep check failed: ${data.error}`);
    }
    return;
  }
  
  const items = data.newlyAddedItems;
  const grouped = {};
  
  // Group items by name
  items.forEach((item) => {
    const name = item.market_hash_name || `Item ID: ${item.assetid}`;
    if (!grouped[name]) {
      grouped[name] = { count: 0, icon: item.icon_url };
    }
    grouped[name].count++;
  });
  
  const totalItems = items.length;
  const sortedEntries = Object.entries(grouped).sort((a, b) => b[1].count - a[1].count);
  
  // Update scan result modal content
  elements.scanResultTitle.textContent = `Successfully scanned "${appState.currentCasketName}"`;
  elements.scanResultSummary.textContent = `${totalItems} new item(s) detected. Scan took ${Math.round(data.totalTimeMs / 1000)} seconds.`;
  elements.scanResultList.innerHTML = '';
  
  const baseIconUrl = "https://steamcommunity-a.akamaihd.net/economy/image/";
  
  sortedEntries.forEach(([name, info]) => {
    const li = document.createElement('li');
    li.className = 'scan-result-item';
    
    li.innerHTML = `
      <img src="${baseIconUrl}${info.icon}" alt="${name}" onerror="this.src='static/images/default-item.png'">
      <div class="scan-result-item-info">
        <div class="scan-result-item-name">${name}</div>
        <div class="scan-result-item-count">Quantity: ${info.count}</div>
      </div>
    `;
    
    elements.scanResultList.appendChild(li);
  });
  
  showModal('scan-result-modal');
  
  // Log success
  logger.log(`Deep check completed successfully: ${totalItems} items found in ${data.totalTimeMs}ms`);
  
  // Re-enable all storage unit elements
  document.querySelectorAll('.storage-unit').forEach(el => {
    el.style.pointerEvents = 'auto';
  });
}

// Inventory needs handling
function handleInventoryNeeds(data) {
  appState.inventoryNeedsPayload = data;
  
  // Update modal text
  const totalMissing = data.needed.reduce((sum, n) => sum + n.missing, 0);
  elements.moveItemsText.textContent = 
    `You are missing ${totalMissing} item(s) for open orders. Move them now?`;
  
  showModal('move-items-modal');
}

async function moveItemsFromStorage() {
  try {
    hideModal('move-items-modal');
    showLoading();
    
    const response = await window.electronAPI.moveItemsFromStorage(appState.inventoryNeedsPayload);
    hideLoading();
    
    if (response.success) {
      toast.success('Items moved successfully');
    } else {
      toast.error(`Failed to move items: ${response.error}`);
    }
  } catch (error) {
    hideLoading();
    logger.error('Error moving items from storage', error);
    toast.error('An error occurred while moving items');
  }
}

// Event Listeners
function setupEventListeners() {
  // Login form submit
  if (elements.loginForm) {
    elements.loginForm.addEventListener('submit', handleLogin);
  }
  
  // Login button
  document.getElementById('login-button').addEventListener('click', handleLogin);
  
  // Switch account button
  document.getElementById('switch-account-button').addEventListener('click', () => {
    showView('login');
  });
  
  // Modal close buttons and overlay clicks
  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const modal = e.target.closest('.modal-overlay');
      if (modal) hideModal(modal.id);
    });
  });
  
  document.querySelectorAll('.modal-overlay').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) hideModal(modal.id);
    });
  });
  
  // Steam Guard submit button
  document.getElementById('steam-guard-submit').addEventListener('click', submitSteamGuardCode);
  
  // 2FA submit button
  document.getElementById('device-2fa-submit').addEventListener('click', submitDevice2FACode);
  
  // Close scan result modal
  document.getElementById('scan-result-close').addEventListener('click', () => {
    hideModal('scan-result-modal');
  });
  
  // Close inventory full modal
  document.getElementById('inventory-full-close').addEventListener('click', () => {
    hideModal('inventory-full-modal');
  });
  
  // Close not registered modal
  document.getElementById('not-registered-close').addEventListener('click', () => {
    hideModal('account-not-registered-modal');
  });
  
  // Close warning modal
  document.getElementById('warning-close').addEventListener('click', () => {
    hideModal('warning-modal');
  });
  
  // Move items buttons
  document.getElementById('move-items-yes').addEventListener('click', moveItemsFromStorage);
  document.getElementById('move-items-no').addEventListener('click', () => {
    hideModal('move-items-modal');
  });
}

// Set up IPC event handlers
function setupIPCHandlers() {



  function setupUpdateHandlers() {
  // Update available
  window.electronAPI.onUpdateAvailable((info) => {
    logger.log(`Update available: ${info.version}`);
    updateState.updateAvailable = true;
    updateState.currentVersion = info.version;
    showUpdateNotification(info);
  });
  
  // Download progress
  window.electronAPI.onDownloadProgress((progress) => {
    handleDownloadProgress(progress);
  });
  
  // Update downloaded
  window.electronAPI.onUpdateDownloaded((info) => {
    logger.log(`Update downloaded: ${info.version}`);
    handleUpdateDownloaded(info);
    toast.success('Update downloaded successfully!');
  });
  }


  // Login events
  window.electronAPI.onLoginSuccess(() => {
    hideLoading();
    showView('dashboard');
  });
  
  window.electronAPI.onLoginFailed((error) => {
    hideLoading();
    logger.error('Login failed', error);
    toast.error('Login failed: ' + error);
  });
  
  // Steam Guard
  window.electronAPI.onSteamGuardRequired((domain) => {
    const promptEl = document.getElementById('steam-guard-prompt');
    promptEl.textContent = domain
      ? `Enter Steam Guard code for ${domain}:`
      : 'Enter your Steam Guard code:';
      
    showModal('steam-guard-modal');
  });
  
  // 2FA
  window.electronAPI.onPleaseEnter2FA(() => {
    showModal('device-2fa-modal');
  });
  
  // Storage items
  window.electronAPI.onStorageItems((_, caskets) => {
    renderStorageUnits(caskets);
  });
  
  // Deep check progress
  window.electronAPI.onDeepCheckProgress((data) => {
    updateLoadingProgress(data.progress, data.currentMovement, data.totalMovements);
  });
  
  // Deep check result
  window.electronAPI.onDeepCheckResult((data) => {
    handleDeepCheckResult(data);
  });
  
  // Account details
  window.electronAPI.onAccountDetails((_, data) => {
    logger.log(`Received account details: ${JSON.stringify(data)}`);
    
    if (data.displayName) {
      elements.displayUsername.textContent = data.displayName;
    }
    
    if (data.avatarUrl) {
      elements.userAvatar.src = data.avatarUrl;
    }
  });
  
  // Account not registered
  window.electronAPI.onAccountNotRegistered((account) => {
    elements.notRegisteredAccountName.textContent = account.displayName || account.steamId;
    showModal('account-not-registered-modal');
  });
  
  // Login warning
  window.electronAPI.onLoginWarning((message) => {
    elements.warningMessage.textContent = message;
    showModal('warning-modal');
  });
  
  // Storage error
  window.electronAPI.onStorageError((_, error) => {
    hideLoading();
    logger.error('Storage error', error);
    toast.error(`Storage error: ${error}`);
  });
  
  // Log event
  window.electronAPI.onLogEvent((message) => {
    logger.log(message);
  });
  
  // Inventory needs
  window.electronAPI.onInventoryNeeds((data) => {
    handleInventoryNeeds(data);
  });
}

// Initialize app
function initApp() {
  setupEventListeners();
  setupIPCHandlers();
  showView('login');
  setupUpdateHandlers(); // Add this line
  logger.log('Application initialized');
}

// Run initialization when DOM is loaded
document.addEventListener('DOMContentLoaded', initApp);

// Make functions available globally for HTML onclick attributes
window.login = handleLogin;
window.showDashboard = () => showView('dashboard');
window.showLogin = () => showView('login');
window.submitSteamGuardCode = submitSteamGuardCode;
window.submitDevice2FACode = submitDevice2FACode;
window.closeScanResultModal = () => hideModal('scan-result-modal');
window.closeInventoryFullModal = () => hideModal('inventory-full-modal');
window.closeNotRegisteredModal = () => hideModal('account-not-registered-modal');
window.closeWarningModal = () => hideModal('warning-modal');