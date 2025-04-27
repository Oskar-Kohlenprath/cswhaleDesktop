// main.js
require("dotenv").config();
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require('fs');
const os = require('os');

// Steam libraries
const SteamUser = require("steam-user");
const GlobalOffensive = require("globaloffensive");
const SteamCommunity = require("steamcommunity");
const axios = require("axios");
const keytar = require("keytar");
const jwt_decode = require("jwt-decode");

// Constants
const SERVICE_NAME = "cs-assets-service";
const ACCOUNTS_KEY = "cs-assets-stored-accounts";
const DEVICE_TOKEN_KEY = "cs-assets-device-token";
const DELAY_MS = 130;
const MAX_INVENTORY_SIZE = 1000;
const MAX_CASKET_SIZE = 1000;
const INVENTORY_BUFFER = 50; // Increased buffer for safety
const SAFE_INVENTORY_SIZE = MAX_INVENTORY_SIZE - INVENTORY_BUFFER;
const API_BASE_URL = "https://cs-assets-oskarkohlenprath.pythonanywhere.com/api";

// Global variables
let mainWindow;
let user; // SteamUser instance
let csgo; // GlobalOffensive instance
let community; // SteamCommunity instance
let lastReceivedToken = null;
let logStream; // For file logging

/**
 * Enhanced logger with file logging and console output
 */
class Logger {
  constructor() {
    this.setupFileLogging();
  }

  setupFileLogging() {
    try {
      const logDir = path.join(app.getPath('userData'), 'logs');
      
      // Create logs directory if it doesn't exist
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      
      const date = new Date().toISOString().split('T')[0];
      const logFile = path.join(logDir, `cs-assets-${date}.log`);
      
      logStream = fs.createWriteStream(logFile, { flags: 'a' });
      
      this.info(`Logger initialized. Logs will be saved to: ${logFile}`);
    } catch (err) {
      console.error('Failed to set up file logging:', err);
    }
  }

  log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const formattedMessage = `[${timestamp}] [${level}] ${message}`;
    
    // Log to console
    if (level === 'ERROR') {
      console.error(formattedMessage);
    } else if (level === 'WARN') {
      console.warn(formattedMessage);
    } else {
      console.log(formattedMessage);
    }
    
    // Log to file
    if (logStream) {
      logStream.write(formattedMessage + os.EOL);
    }
    
    // Send to renderer (but not full error objects)
    if (mainWindow && !mainWindow.isDestroyed()) {
      const simplifiedMessage = typeof message === 'object' 
        ? JSON.stringify(message) 
        : message;
      
      mainWindow.webContents.send("log-event", simplifiedMessage);
    }
  }

  info(message) {
    this.log(message, 'INFO');
  }

  warn(message) {
    this.log(message, 'WARN');
  }

  error(message, error) {
    // Log the main message
    this.log(message, 'ERROR');
    
    // If there's an error object, log its details too
    if (error) {
      if (error.stack) {
        this.log(`Error Stack: ${error.stack}`, 'ERROR');
      } else {
        this.log(`Error Details: ${JSON.stringify(error)}`, 'ERROR');
      }
    }
  }
}

const logger = new Logger();

/**
 * Create the main application window
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, "static/images/favicon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      enableRemoteModule: false,
    },
    // Add modern window features
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f172a', // Match our dark theme background
    show: false, // Don't show until ready
  });

  // Create splash screen
  const splash = new BrowserWindow({
    width: 400,
    height: 400,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    center: true,
  });

  splash.loadFile("static/splash.html");
  mainWindow.loadFile("index.html");

  // Show main window when it's ready, and close splash screen
  mainWindow.once('ready-to-show', () => {
    splash.destroy();
    mainWindow.show();
  });

  // Open DevTools only in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
  
  // Handle window close
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Initialize application
 */
app.whenReady().then(async () => {
  logger.info("Application starting...");
  
  // Create community instance
  community = new SteamCommunity();
  
  // Initialize window
  createWindow();

  // Validate tokens
  await validateAllStoredTokens();

  // Fetch accounts if device token exists
  try {
    const deviceToken = await keytar.getPassword(SERVICE_NAME, DEVICE_TOKEN_KEY);
    if (deviceToken) {
      await fetchAndUpdateAccountsFromFlask(deviceToken);
    }
  } catch (err) {
    logger.error("Error fetching accounts on startup", err);
  }
});

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

/**
 * Fetch and update accounts from Flask API
 * @param {string} deviceToken - The device token for authentication
 * @returns {Array} Updated accounts list
 */
async function fetchAndUpdateAccountsFromFlask(deviceToken) {
  try {
    const serverUrl = `${API_BASE_URL}/desktop_steam_accounts`;
    const resp = await axios.post(serverUrl, { device_token: deviceToken });
    const steamAccounts = resp.data.steam_accounts || [];
    logger.info(`Flask returned ${steamAccounts.length} steam accounts.`);

    // Load current accounts
    const existingAccounts = await loadAccountsJSON();
    const updatedAccounts = [...existingAccounts];

    // Process accounts from Flask API
    for (const flaskAccount of steamAccounts) {
      const steamId = flaskAccount.steam_id;
      const displayName = flaskAccount.persona_name || steamId;
      const avatarUrl = flaskAccount.avatar_url || "static/images/default-avatar.png";

      // Check if this account already exists
      const existingIdx = existingAccounts.findIndex(
        (a) => a.steamId === steamId
      );

      if (existingIdx >= 0) {
        // Update existing account
        updatedAccounts[existingIdx].displayName = displayName;
        updatedAccounts[existingIdx].avatarUrl = avatarUrl;
        updatedAccounts[existingIdx].isRegistered = true;
        // Keep existing refreshToken if it exists
      } else {
        // Add new account from Flask with no refresh token
        updatedAccounts.push({
          steamId,
          displayName,
          avatarUrl,
          refreshToken: "",
          isRegistered: true,
          lastUsed: Date.now(),
        });
      }
    }

    // Save updated accounts list
    await saveAccountsJSON(updatedAccounts);

    return updatedAccounts;
  } catch (err) {
    logger.error("Error fetching accounts from Flask", err);
    throw err;
  }
}

/**
 * Handle IPC request to get saved accounts
 */
ipcMain.handle("get-saved-accounts", async () => {
  // Fetch all accounts from Keytar
  const allAccounts = await getAllAccounts();
  return allAccounts;
});

/**
 * Load accounts from secure storage
 * @returns {Array} List of stored accounts
 */
async function loadAccountsJSON() {
  try {
    const existing = await keytar.getPassword(SERVICE_NAME, ACCOUNTS_KEY);
    if (!existing) {
      // No data stored yet
      return [];
    }
    return JSON.parse(existing);
  } catch (err) {
    logger.error("Error parsing stored accounts JSON", err);
    return [];
  }
}

/**
 * Save accounts to secure storage
 * @param {Array} accounts - List of accounts to save
 */
async function saveAccountsJSON(accounts) {
  try {
    const json = JSON.stringify(accounts);
    await keytar.setPassword(SERVICE_NAME, ACCOUNTS_KEY, json);
  } catch (err) {
    logger.error("Error saving accounts to storage", err);
    throw err;
  }
}

/**
 * Get all stored accounts
 * @returns {Array} List of all accounts
 */
async function getAllAccounts() {
  return await loadAccountsJSON();
}

/**
 * Save account data to storage
 * @param {Object} accountData - Account data to save
 */
async function saveAccountData({
  steamId,
  displayName,
  refreshToken,
  isRegistered,
  avatarUrl
}) {
  try {
    const accounts = await loadAccountsJSON();

    // If we're saving a non-empty refresh token, verify it's unique
    if (refreshToken && refreshToken.trim() !== "") {
      // First verify the token belongs to this account
      const tokenSteamId = extractSteamIdFromToken(refreshToken);

      if (tokenSteamId && tokenSteamId !== steamId) {
        logger.warn(
          `WARNING: Attempted to save a token for ${steamId} that belongs to ${tokenSteamId}`
        );
        // Token belongs to a different account - don't save it
        return;
      }

      // Check if this token is already saved to a different account
      const existingWithToken = accounts.find(
        (a) => a.steamId !== steamId && a.refreshToken === refreshToken
      );

      if (existingWithToken) {
        logger.warn(
          `Token uniqueness violation detected. Token already exists for account ${
            existingWithToken.displayName || existingWithToken.steamId
          }`
        );

        // Remove the token from the other account
        logger.info(
          `Removing duplicate token from account ${
            existingWithToken.displayName || existingWithToken.steamId
          }`
        );

        const otherIdx = accounts.findIndex(
          (a) => a.steamId === existingWithToken.steamId
        );
        if (otherIdx >= 0) {
          accounts[otherIdx].refreshToken = "";
        }
      }
    }

    // Now save/update the current account
    const idx = accounts.findIndex((a) => a.steamId === steamId);
    if (idx >= 0) {
      // Update existing account
      if (displayName) accounts[idx].displayName = displayName;
      if (refreshToken !== undefined) accounts[idx].refreshToken = refreshToken;
      if (avatarUrl) accounts[idx].avatarUrl = avatarUrl;
      accounts[idx].lastUsed = Date.now();
      
      // Only update isRegistered if provided
      if (typeof isRegistered !== "undefined") {
        accounts[idx].isRegistered = isRegistered;
      }
    } else {
      // Add new account
      accounts.push({
        steamId,
        displayName: displayName || steamId,
        refreshToken: refreshToken || "",
        avatarUrl: avatarUrl || "static/images/default-avatar.png",
        lastUsed: Date.now(),
        isRegistered: typeof isRegistered !== "undefined" ? isRegistered : false,
      });
    }

    await saveAccountsJSON(accounts);

    // If this was a token update, send notification to the user
    
  } catch (err) {
    logger.error("Error saving account data", err);
  }
}

/**
 * Handle login with refresh token
 */
ipcMain.handle('login-with-refresh-token', async (event, steamId) => {
  try {
    const accounts = await getAllAccounts();
    const found = accounts.find(a => a.steamId === steamId);
    
    if (!found || !found.refreshToken || found.refreshToken.trim() === '') {
      throw new Error('No valid refresh token for this account');
    }
    
    // Terminate any existing session
    await terminateSteamSession();
    
    // Log in with the token
    await initCSGO({ refreshToken: found.refreshToken });
    
    // Update account's last used timestamp
    await saveAccountData({
      steamId,
      displayName: found.displayName,
      lastUsed: Date.now()
    });
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('login-success');
    }
  } catch (error) {
    logger.error('Login with refresh token failed', error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('login-failed', "Login failed. Please try again.");
    }
  }
});

/**
 * Handle moving items from storage
 */
ipcMain.handle('move-items-from-storage', async (_event, payload) => {
  try {
    await performMoves(payload);
    return { success: true };
  } catch (err) {
    logger.error("Move items operation failed", err);
    return { success: false, error: "Failed to move items. Please try again." };
  }
});

/**
 * Handle login credentials from renderer
 */
ipcMain.on('login-credentials', async (event, credentials) => {
  try {
    await terminateSteamSession();
    await initCSGO(credentials);
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('login-success');
    }
  } catch (error) {
    logger.error('Login failed', error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('login-failed', "Login failed. Please check your credentials and try again.");
    }
  }
});

/**
 * Handle fetch storage request
 */
ipcMain.on("fetch-storage", async () => {
  try {
    if (!user || !csgo || !csgo.haveGCSession) {
      throw new Error("Not connected to Steam. Please log in first.");
    }
    
    const caskets = await fetchAllCaskets();
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("storage-items", caskets);
    }
    
    // Get the current Steam account id from the logged-in user
    const steamAccountId = user.steamID.getSteamID64();
    
    // Send the caskets to the Flask endpoint
    try {
      const serverResponse = await sendStorageUnitsToServer(caskets, steamAccountId);
      logger.info(`Storage units sent to server: ${JSON.stringify(serverResponse)}`);
    } catch (serverErr) {
      logger.error("Error sending storage units to server", serverErr);
      // We don't need to notify the user about this server-side issue
    }
  } catch (error) {
    logger.error("Error fetching storage units", error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("storage-error", "Failed to fetch storage units. Please try again.");
    }
  }
});

/**
 * Handle casket deep check request
 */
ipcMain.on("casket-deep-check", async (event, casketId) => {
  const startTime = Date.now();

  try {
    logger.info(`Starting deep-check on storage unit ${casketId}...`);

    if (!user || !csgo || !csgo.haveGCSession) {
      throw new Error("Not connected to Steam. Please log in first.");
    }

    // 1) Fetch old local web inventory
    logger.info("Fetching old web inventory...");
    const oldInventory = await getWebInventory();
    const oldInventoryCount = oldInventory.length;
    logger.info(`Got old web inventory: ${oldInventoryCount} items.`);

    // Check inventory space
    if (oldInventoryCount > SAFE_INVENTORY_SIZE) {
      throw new Error("Your inventory is too full to perform a deep check. Please make some space first.");
    }

    // Potential "space" items (tradable, CS:GO)
    const candidateSpaceItems = oldInventory
      .filter((it) => it.tradable && it.appid === 730)
      .map((it) => it.assetid);
    logger.info(`Found ${candidateSpaceItems.length} tradable CS:GO items in old inventory.`);

    // 2) Get casket contents
    logger.info(`Getting storage unit ${casketId} contents...`);
    const casketItems = await fetchCasketContents(casketId);
    logger.info(`Storage unit ${casketId} has ${casketItems.length} item(s).`);

    const casketCount = casketItems.length;
    const originalCasketIds = casketItems.map((it) => it.id);

    // Track space items we temporarily move
    const temporarilyMovedIntoCasket = [];

    // Current counters
    let currentInventorySize = oldInventoryCount;
    let currentCasketSize = casketCount;

    // Progress bar
    const totalMovements = 3 * casketCount;
    let currentMovement = 0;
    function updateProgress(extra = 1) {
      currentMovement += extra;
      const progress = Math.min(
        100,
        Math.round((currentMovement / totalMovements) * 100)
      );
      
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("deep-check-progress", {
          progress,
          currentMovement,
          totalMovements,
        });
      }
    }

    // Copy casket items for chunk-based processing
    let remainingCasketItems = [...casketItems];

    // List of newly discovered items
    const newlyAddedItems = [];

    // Start with a chunk size
    let chunkSize = 50;

    while (remainingCasketItems.length > 0) {
      if (chunkSize > remainingCasketItems.length) {
        chunkSize = remainingCasketItems.length;
      }
      const batch = remainingCasketItems.slice(0, chunkSize);

      // 1) Ensure enough free slots in inventory
      let freeSlots = SAFE_INVENTORY_SIZE - currentInventorySize;
      if (freeSlots < chunkSize) {
        let needed = chunkSize - freeSlots;
        while (needed > 0) {
          // If the casket is full, reduce chunk size or abort
          if (currentCasketSize >= MAX_CASKET_SIZE) {
            if (chunkSize > 1) {
              chunkSize = Math.max(1, chunkSize - 1);
              logger.info(`Chunk too big. Reducing chunk size to ${chunkSize} and retrying...`);
            } else {
              throw new Error("Not enough space in inventory or storage unit. Operation aborted.");
            }
            break;
          }
          // Move one space item from inventory -> casket
          const itemToMove = candidateSpaceItems.find(
            (id) => !originalCasketIds.includes(id)
          );
          if (!itemToMove) {
            if (chunkSize > 1) {
              chunkSize = Math.max(1, chunkSize - 1);
              logger.info(`No more space-items. Reducing chunk size to ${chunkSize} and retrying...`);
            } else {
              throw new Error("Not enough movable items in inventory. Operation aborted.");
            }
            break;
          }
          logger.info(`Moving space-item ${itemToMove} -> casket ${casketId} to free a slot.`);
          csgo.addToCasket(casketId, itemToMove);
          await delay(DELAY_MS);

          temporarilyMovedIntoCasket.push(itemToMove);
          candidateSpaceItems.splice(
            candidateSpaceItems.indexOf(itemToMove),
            1
          );
          currentInventorySize--;
          currentCasketSize++;
          needed--;
          updateProgress(1);
          freeSlots = SAFE_INVENTORY_SIZE - currentInventorySize;
        }
        if (freeSlots < chunkSize) {
          continue;
        }
      }

      // 2) Remove items from casket -> inventory
      for (const gcItem of batch) {
        logger.info(`Removing item ${gcItem.id} from storage unit ${casketId}...`);
        csgo.removeFromCasket(casketId, gcItem.id);
        await delay(DELAY_MS);

        currentInventorySize++;
        currentCasketSize--;
        updateProgress(1);
      }

      // 3) Refresh local web inventory
      logger.info(`Fetching new web inventory after removing ${batch.length} item(s)...`);
      const newInventory = await getWebInventory();
      logger.info(`Got new web inventory: ${newInventory.length} items.`);

      // 3.1) We want to detect items that weren't in oldInventory
      const oldIdsSet = new Set(oldInventory.map((it) => it.assetid));
      const rawNewlyAdded = newInventory.filter(
        (it) => !oldIdsSet.has(it.assetid)
      );

      // 3.2) Transform each newly added item to ensure we pass relevant fields
      const mappedNewlyAdded = rawNewlyAdded.map((item) => ({
        assetid: item.assetid,
        classid: item.classid || "",
        instanceid: item.instanceid || "",
        market_hash_name: item.market_hash_name || "",
        icon_url: item.icon_url || "",
        tradable: item.tradable || false,
        appid: item.appid,
      }));

      newlyAddedItems.push(...mappedNewlyAdded);
      logger.info(`Found ${mappedNewlyAdded.length} new item(s) in inventory.`);
      updateProgress(1);

      // 4) Put items back into casket
      for (const gcItem of batch) {
        logger.info(`Putting item ${gcItem.id} back to casket ${casketId}...`);
        csgo.addToCasket(casketId, gcItem.id);
        await delay(DELAY_MS);

        currentInventorySize--;
        currentCasketSize++;
        updateProgress(1);
      }

      remainingCasketItems.splice(0, chunkSize);
    }

    // Move space items back
    if (temporarilyMovedIntoCasket.length > 0) {
      logger.info(`Moving ${temporarilyMovedIntoCasket.length} space-item(s) back to main inventory...`);
    }
    
    const returnBatchSize = 200;
    for (let i = 0; i < temporarilyMovedIntoCasket.length; i += returnBatchSize) {
      const batch = temporarilyMovedIntoCasket.slice(i, i + returnBatchSize);
      for (const itemId of batch) {
        if (currentInventorySize >= SAFE_INVENTORY_SIZE) {
          throw new Error("Inventory unexpectedly full while returning space-items.");
        }
        logger.info(`Returning space item ${itemId} to main inventory...`);
        csgo.removeFromCasket(casketId, itemId);
        await delay(DELAY_MS);

        currentInventorySize++;
        currentCasketSize--;
        updateProgress(1);
      }
    }

    // Finished
    const totalMs = Date.now() - startTime;
    logger.info(`Deep-check complete. Total time: ${totalMs} ms.`);

    // Send newly discovered items to Flask
    const steamAccountId = user.steamID.getSteamID64();
    try {
      const serverResponse = await sendNewItemsToServer(
        casketId,
        newlyAddedItems,
        steamAccountId
      );
      logger.info(`Server response for new items: ${JSON.stringify(serverResponse)}`);
    } catch (serverErr) {
      logger.error("Error sending new items to server", serverErr);
      // We'll still proceed with reporting the deep-check to the UI
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("deep-check-result", {
        success: true,
        newlyAddedItems,
        totalTimeMs: totalMs,
        estimatedSeconds: Math.round(totalMs / 1000),
      });
    }
  } catch (error) {
    logger.error("Error in deep-check operation", error);
    
    const totalMs = Date.now() - startTime;
    logger.info(`Deep-check ended with error. Time: ${totalMs} ms.`);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("deep-check-result", {
        success: false,
        error: error.message || "Unknown error during deep check",
        totalTimeMs: totalMs,
      });
    }
  }
});

/**
 * Send newly discovered items to server
 * @param {string} casketId - Storage unit ID
 * @param {Array} newlyAddedItems - Items to send
 * @param {string} steamAccountId - Steam account ID
 * @returns {Object} Server response
 */
async function sendNewItemsToServer(casketId, newlyAddedItems, steamAccountId) {
  try {
    const serverUrl = `${API_BASE_URL}/register_storage_items`;
    const payload = {
      steam_account_id: steamAccountId,
      storage_unit_id: casketId,
      items: newlyAddedItems,
    };
    
    const resp = await axios.post(serverUrl, payload, {
      withCredentials: true,
    });
    
    if (!resp.data.success) {
      throw new Error(resp.data.error || "Unknown error from server");
    }
    
    return resp.data;
  } catch (err) {
    logger.error(`Error sending new items to server: ${err.message}`);
    throw err;
  }
}

/**
 * Send storage units to server
 * @param {Array} caskets - Storage units to send
 * @param {string} steamAccountId - Steam account ID
 * @returns {Object} Server response
 */
async function sendStorageUnitsToServer(caskets, steamAccountId) {
  try {
    const serverUrl = `${API_BASE_URL}/register_storage_units`;
    
    // Prepare payload with steam_account_id and storage units
    const payload = {
      steam_account_id: steamAccountId,
      storage_units: caskets.map((casket) => ({
        storage_unit_id: casket.casketId,
        name: casket.casketName,
      })),
    };
    
    const resp = await axios.post(serverUrl, payload, {
      withCredentials: true,
    });
    
    if (!resp.data.success) {
      throw new Error(resp.data.error || "Unknown error from server");
    }
    
    return resp.data;
  } catch (err) {
    logger.error(`Error sending storage units to server: ${err.message}`);
    throw err;
  }
}

/**
 * Initialize CS:GO connection
 * @param {Object} credentials - Login credentials
 * @returns {Promise} Resolves when connected
 */
async function initCSGO(credentials) {
  return new Promise((resolve, reject) => {
    if (user && csgo && csgo.haveGCSession) {
      logger.info('Already logged in with an active GC session.');
      return resolve();
    }

    // Reset the lastReceivedToken for this login session
    lastReceivedToken = null;

    // Create new user and csgo instances
    user = new SteamUser();
    csgo = new GlobalOffensive(user);

    // Simple token capture without immediate saving
    user.on("refreshToken", (token) => {
      if (!token) {
        logger.warn("Got an empty refresh token from steam-user");
        return;
      }
      
      logger.info(`Received new refresh token from Steam`);
      lastReceivedToken = token; // Store it for later use
    });

    // On successful login, handle token saving
    user.on("loggedOn", async () => {
      const steamId = user.steamID.getSteamID64();
      logger.info(`Logged in as ${steamId}`);
      
      user.setPersona(SteamUser.EPersonaState.Online);
      user.gamesPlayed([730]);

      // Determine which token to use - either the one we just received or the one from credentials
      let finalToken = lastReceivedToken;
      if (!finalToken && credentials.refreshToken) {
        finalToken = credentials.refreshToken;
        logger.info(`Using token from credentials`);
      }

      // Handle device token
      let dt = await keytar.getPassword(SERVICE_NAME, DEVICE_TOKEN_KEY);
      if (!dt) {
        try {
          dt = await ensureDeviceToken(steamId);
          logger.info(`Device token is confirmed`);
        } catch (err) {
          logger.error('Error ensuring device token', err);
          return;
        }
      }

      // Get accounts from Flask API
      try {
        const accounts = await fetchAndUpdateAccountsFromFlask(dt);
        const loggedInAccount = accounts.find(a => a.steamId === steamId);

        if (loggedInAccount) {
          // This is a registered account
          if (finalToken) {
            // Only save token for THIS account
            await saveAccountData({
              steamId,
              displayName: loggedInAccount.displayName,
              refreshToken: finalToken,
              isRegistered: true,
              avatarUrl: loggedInAccount.avatarUrl
            });
            
            // Also check if this token is duplicated in other accounts and remove it
            await removeTokenFromOtherAccounts(finalToken, steamId);
          }

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('account-details', {
              steamId,
              displayName: loggedInAccount.displayName,
              avatarUrl: loggedInAccount.avatarUrl || 'static/images/default-avatar.png'
            });
          }

          // Ask Flask what we still need in live inventory
          try {
            await checkInventoryNeeds(steamId);
          } catch (err) {
            logger.error(`Inventory-needs check failed`, err);
          }
        } else {
          // Not a registered account
          logger.warn(`Account ${steamId} not found in Flask accounts list`);
          
          if (finalToken) {
            await saveAccountData({
              steamId,
              displayName: credentials.username || steamId,
              refreshToken: finalToken,
              isRegistered: false
            });
            
            // Also remove this token from other accounts
            await removeTokenFromOtherAccounts(finalToken, steamId);
          }

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('account-details', {
              steamId,
              displayName: credentials.username || steamId,
              avatarUrl: 'static/images/default-avatar.png'
            });
            
            mainWindow.webContents.send('account-not-registered', {
              steamId,
              displayName: credentials.username || steamId
            });
          }
        }
      } catch (err) {
        logger.error(`Error during account processing`, err);
        
        // Even if Flask fails, save the token
        if (finalToken) {
          await saveAccountData({
            steamId,
            displayName: credentials.username || steamId,
            refreshToken: finalToken
          });
          
          await removeTokenFromOtherAccounts(finalToken, steamId);
        }
      }
    });

    // Web session handling
    user.on("webSession", (sessionID, cookies) => {
      logger.info(`Obtained web session: ${sessionID}`);
      community.setCookies(cookies);
    });

    // Steam Guard handling
    user.on("steamGuard", (domain, callback) => {
      logger.info(`SteamGuard code required for domain: ${domain}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("steamGuard-required", domain);
        ipcMain.once("steamGuard-code", (_event, code) => {
          logger.info(`Received SteamGuard code from renderer`);
          callback(code);
        });
      } else {
        reject(new Error("Main window not available for SteamGuard prompt."));
      }
    });

    // Error handling
    user.on("error", (err) => {
      logger.error(`Steam user error`, err);
      reject(err);
    });

    // CS:GO connection events
    csgo.on("connectedToGC", () => {
      logger.info("Connected to GC.");
      resolve();
    });

    csgo.on("disconnectedFromGC", (reason) => {
      logger.warn(`Disconnected from GC: ${reason}`);
    });

    // Login with credentials
    if (credentials.refreshToken) {
      user.logOn({
        refreshToken: credentials.refreshToken,
      });
    } else {
      user.logOn({
        accountName: credentials.username,
        password: credentials.password,
      });
    }
  });
}

/**
 * Remove token from other accounts
 * @param {string} token - Token to remove
 * @param {string} exceptSteamId - Steam ID to exclude
 */
async function removeTokenFromOtherAccounts(token, exceptSteamId) {
  if (!token) return;
  
  try {
    const accounts = await getAllAccounts();
    let hasChanges = false;
    
    for (const account of accounts) {
      if (account.steamId !== exceptSteamId && account.refreshToken === token) {
        logger.info(`Removing duplicate token from account ${account.displayName || account.steamId}`);
        account.refreshToken = '';
        hasChanges = true;
      }
    }
    
    if (hasChanges) {
      await saveAccountsJSON(accounts);
    }
  } catch (err) {
    logger.error(`Error removing duplicate tokens`, err);
  }
}

/**
 * Get web inventory
 * @returns {Promise<Array>} Inventory items
 */
async function getWebInventory() {
  logger.info("Fetching web inventory...");
  return new Promise((resolve, reject) => {
    community.getUserInventoryContents(
      user.steamID,
      730,
      2,
      false,
      (err, inventory) => {
        if (err) {
          logger.error(`Error fetching inventory`, err);
          return reject(err);
        }
        logger.info(`Inventory fetched. Count = ${inventory.length}`);
        resolve(inventory);
      }
    );
  });
}

/**
 * Fetch all storage units (caskets)
 * @returns {Promise<Array>} List of storage units
 */
async function fetchAllCaskets() {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (!csgo || !csgo.inventory || csgo.inventory.length === 0) {
        return reject(new Error("No items found in inventory."));
      }
      
      const storageUnits = csgo.inventory.filter(
        (item) => typeof item.casket_contained_item_count !== "undefined"
      );
      
      if (storageUnits.length === 0) {
        return reject(new Error("No storage units found."));
      }
      
      const casketArray = storageUnits.map((unit) => ({
        casketId: unit.id,
        casketName: unit.custom_name || "Unnamed Storage",
        itemCount: unit.casket_contained_item_count || 0,
      }));
      
      resolve(casketArray);
    }, 2000);
  });
}

/**
 * Fetch storage unit contents
 * @param {string} casketId - Storage unit ID
 * @returns {Promise<Array>} List of items in storage unit
 */
async function fetchCasketContents(casketId) {
  return new Promise((resolve, reject) => {
    csgo.getCasketContents(casketId, (err, items) => {
      if (err) return reject(err);
      resolve(items);
    });
  });
}

/**
 * Delay execution
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise} Resolves after delay
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract Steam ID from token
 * @param {string} token - Refresh token
 * @returns {string|null} Steam ID or null
 */
function extractSteamIdFromToken(token) {
  if (!token) return null;
  
  try {
    const decoded = jwt_decode(token);
    return decoded.sub || null;
  } catch (err) {
    logger.error("Error decoding token", err);
    return null;
  }
}

/**
 * Terminate Steam session
 */
async function terminateSteamSession() {
  if (!user) return;
  
  logger.info('Terminating existing Steam session...');
  
  try {
    // Stop playing games
    if (user.steamID) {
      user.gamesPlayed([]);
      user.logOff();
      
      // Wait for logoff
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Create new instances
    user = new SteamUser();
    csgo = new GlobalOffensive(user);
    
    lastReceivedToken = null; // Reset the token cache
    
    logger.info('Session terminated successfully');
  } catch (err) {
    logger.error(`Error in session termination`, err);
    
    // Force new instances
    user = new SteamUser();
    csgo = new GlobalOffensive(user);
  }
}

/**
 * Validate all stored tokens
 */
async function validateAllStoredTokens() {
  logger.info("Validating all stored refresh tokens...");

  try {
    const accounts = await getAllAccounts();
    let hasChanges = false;

    // Track tokens we've seen to detect duplicates
    const seenTokens = new Map(); // token -> steamId

    // First pass - detect and resolve duplicates
    for (const account of accounts) {
      const token = account.refreshToken;

      if (!token || token.trim() === "") {
        continue; // Skip accounts without tokens
      }

      // Check if we've seen this token already
      if (seenTokens.has(token)) {
        const firstAccountId = seenTokens.get(token);
        logger.warn(
          `Duplicate token detected: accounts ${firstAccountId} and ${account.steamId} have the same token`
        );

        // Decode token to see which account it really belongs to
        const tokenSteamId = extractSteamIdFromToken(token);

        if (tokenSteamId) {
          // We know which account this token belongs to
          if (tokenSteamId === account.steamId) {
            // Clear token from the first account
            const firstAccount = accounts.find(
              (a) => a.steamId === firstAccountId
            );
            logger.info(
              `Token belongs to ${account.steamId}, clearing from ${firstAccountId}`
            );
            firstAccount.refreshToken = "";
            hasChanges = true;
          } else if (tokenSteamId === firstAccountId) {
            // Clear token from current account
            logger.info(
              `Token belongs to ${firstAccountId}, clearing from ${account.steamId}`
            );
            account.refreshToken = "";
            hasChanges = true;
          } else {
            // Token doesn't belong to either account
            logger.warn(
              `Token doesn't belong to either account (${firstAccountId} or ${account.steamId}), belongs to ${tokenSteamId}`
            );
            // Clear from both
            account.refreshToken = "";
            const firstAccount = accounts.find(
              (a) => a.steamId === firstAccountId
            );
            firstAccount.refreshToken = "";
            hasChanges = true;
          }
        } else {
          // Can't decode - clear from the second account as a precaution
          logger.warn(
            `Can't decode token, clearing from second account ${account.steamId}`
          );
          account.refreshToken = "";
          hasChanges = true;
        }
      } else {
        // First time seeing this token
        seenTokens.set(token, account.steamId);

        // While we're at it, validate the token belongs to this account
        const tokenSteamId = extractSteamIdFromToken(token);
        if (tokenSteamId && tokenSteamId !== account.steamId) {
          logger.warn(
            `Token for account ${account.steamId} actually belongs to ${tokenSteamId}, clearing`
          );
          account.refreshToken = "";
          hasChanges = true;
        }
      }
    }

    // Save changes if needed
    if (hasChanges) {
      logger.info("Token validation found and fixed issues, saving updated accounts");
      await saveAccountsJSON(accounts);
    } else {
      logger.info("Token validation complete, no issues found");
    }
  } catch (err) {
    logger.error(`Error validating tokens`, err);
  }
}

/**
 * Ensure device token exists
 * @param {string} steamId - Steam ID
 * @returns {Promise<string>} Device token
 */
async function ensureDeviceToken(steamId) {
  // 1) Check if Keytar already has a device token
  const existingToken = await keytar.getPassword(
    SERVICE_NAME,
    DEVICE_TOKEN_KEY
  );
  
  if (existingToken) {
    logger.info("Device token found in Keytar. No 2FA needed.");
    return existingToken;
  }

  logger.info("No device token in Keytar. Initiating 2FA flow via Flask...");

  // 2) Make device_token_request
  try {
    // Adjust the URL to your actual endpoint
    await axios.post(
      `${API_BASE_URL}/device_token_request`,
      {
        steam_id: steamId,
      }
    );

    // 3) Prompt user for the 2FA code from their email
    const twoFaCode = await promptUserFor2FACodeInRenderer();

    // 4) device_token_confirm
    const confirmResp = await axios.post(
      `${API_BASE_URL}/device_token_confirm`,
      {
        steam_id: steamId,
        code: twoFaCode,
      }
    );

    if (!confirmResp.data || !confirmResp.data.device_token) {
      throw new Error("Flask returned no device_token");
    }
    
    const newToken = confirmResp.data.device_token;
    logger.info("Device token obtained from Flask");

    // 5) Store in Keytar
    await keytar.setPassword(SERVICE_NAME, DEVICE_TOKEN_KEY, newToken);
    return newToken;
  } catch (err) {
    if (err.response) {
      logger.error(
        `Error in ensureDeviceToken flow: Status ${err.response.status}`,
        err.response.data
      );
    } else {
      logger.error("Error in ensureDeviceToken flow", err);
    }
    throw err;
  }
}

/**
 * Prompt user for 2FA code
 * @returns {Promise<string>} 2FA code
 */
async function promptUserFor2FACodeInRenderer() {
  return new Promise((resolve) => {
    // Listen once for the code
    ipcMain.once("2fa-code-submitted", (event, code) => {
      resolve(code);
    });
    
    // Ask renderer to open a modal or prompt
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("please-enter-2fa");
      logger.info("2FA prompt sent to renderer");
    }
  });
}

/**
 * Check inventory needs from Flask
 * @param {string} steamId - Steam ID
 */
async function checkInventoryNeeds(steamId) {
  // ①  Push authoritative snapshot to the server
  logger.info("Synchronising inventory snapshot with Flask …");
  try {
    await syncInventoryWithServer(steamId);  // <-- waits for HTTP 200
  } catch (syncErr) {
    logger.error("Inventory sync failed – aborting inventory-needs check", syncErr);
    throw syncErr;                           // bubble up – caller decides next step
  }

  // ②  Now fetch “what do we still need?”
  logger.info("Fetching inventory-needs from API");
  const url = `${API_BASE_URL}/inventory_needs/${steamId}`;

  try {
    const { data } = await axios.get(url, { withCredentials: true });

    if (!data.success) {
      throw new Error(data.error || "Unknown error");
    }

    const needsSomething =
      Array.isArray(data.needed) &&
      data.needed.some(n => n.missing > 0 && n.storage_assetids.length);

    if (needsSomething && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("inventory-needs", data);
    }
  } catch (err) {
    logger.error("Failed to check inventory needs", err);
    throw err;
  }
}







/**
 * Perform item moves from storage to inventory
 * @param {Object} payload - Move payload
 */
async function performMoves({ locked_assetids, needed }) {
  logger.info('Starting automatic inventory-balancing…');

  // 1.  Make a quick inventory + storage snapshot
  const webInv = await getWebInventory();
  const invSize = webInv.length;

  // 2.  Flatten all asset-ids we must bring into inventory
  const bringIn = needed.flatMap(n => n.storage_assetids.slice(0, n.missing));

  if (bringIn.length === 0) {
    logger.info("No items need to be moved");
    return;
  }

  // 3.  Make room if necessary
  const projected = invSize + bringIn.length;
  if (projected > SAFE_INVENTORY_SIZE) {
    const overflow = projected - SAFE_INVENTORY_SIZE;
    logger.info(`Need to park ${overflow} item(s) to storage…`);

    const victims = webInv
      .filter(it => !locked_assetids.includes(it.assetid))
      .slice(0, overflow);

    if (victims.length < overflow) {
      throw new Error('Not enough movable items to free space in inventory');
    }

    // push each victim into the first casket that still has space
    const caskets = await fetchAllCaskets();
    let casketPtr = 0;

    for (const v of victims) {
      while (casketPtr < caskets.length) {
        const ck = caskets[casketPtr];
        if (ck.itemCount < MAX_CASKET_SIZE) {
          csgo.addToCasket(ck.casketId, v.assetid);
          ck.itemCount++;
          await delay(DELAY_MS);
          break;
        }
        casketPtr++;
      }
    }
  }

  // 4.  Pull requested items out of their caskets
  for (const aid of bringIn) {
    // try every casket until we see it
    const caskets = await fetchAllCaskets();
    let found = false;

    for (const ck of caskets) {
      const contents = await fetchCasketContents(ck.casketId);
      const hit = contents.find(it => it.id === aid);
      if (hit) {
        csgo.removeFromCasket(ck.casketId, aid);
        await delay(DELAY_MS);
        found = true;
        break;
      }
    }
    
    if (!found) {
      logger.warn(`Could not find assetid ${aid} in any casket`);
    }
  }

  logger.info('Automatic moves finished successfully');
}







function savePayloadLocally(payload) {
  try {
    const filePath = path.join(os.tmpdir(), `inv_sync_${Date.now()}.json`);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
    logger.info(`payload saved locally to ${filePath}`);
  } catch (err) {
    logger.warn(`could not save payload locally: ${err.message}`);
  }
}

async function syncInventoryWithServer(steamId64) {
  // 1) live inventory ------------------------------------------------------
  const webInv = await getWebInventory();
  const payload = {
    inventory: webInv.map((i) => ({
      assetid: String(i.assetid),
      market_hash_name: i.market_hash_name || "",
      tradable: i.tradable ? 1 : 0,
    })),
  };

  // 2) storage units -------------------------------------------------------
  try {
    const caskets = await fetchAllCaskets();
    for (const ck of caskets) {
      try {
        const items = await fetchCasketContents(ck.casketId);
        payload[ck.casketId] = items.map((it) => String(it.id));
      } catch (e) {
        logger.warn(`Skipping casket ${ck.casketId}: ${e.message}`);
      }
    }
  } catch (_) {
    /* no caskets → fine */
  }

 

  // 3) POST to Flask -------------------------------------------------------
  const url = `${API_BASE_URL}/inventory-sync/${steamId64}`;
  logger.info(`POST → ${url}`);

  try {
    const res = await axios.post(url, payload, {
      withCredentials: true,
      timeout: 15_000,
    });

    logger.info("inventory-sync ok", res.data);
    return res.data;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      const { status, data } = err.response;
      logger.error(`inventory-sync HTTP ${status}`, data);
      throw new Error(data?.error || `inventory-sync failed (${status})`);
    }

    logger.error("inventory-sync network or unknown error", err.message);
    throw err;
  }
}

module.exports = syncInventoryWithServer;











// Handle app quit
app.on('quit', () => {
  if (logStream) {
    logStream.end();
  }
});