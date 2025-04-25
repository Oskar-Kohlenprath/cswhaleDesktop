// main.js
require("dotenv").config();
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

// Steam libraries
const SteamUser = require("steam-user");
const GlobalOffensive = require("globaloffensive");
const SteamCommunity = require("steamcommunity");
const axios = require("axios"); // Make sure axios is installed via `npm install axios`
const keytar = require("keytar");
const jwt_decode = require("jwt-decode");

// Create a SteamCommunity instance for web inventory calls
const community = new SteamCommunity();

let mainWindow;
let user; // Global SteamUser instance
let csgo; // Global GlobalOffensive instance

// Global delay ms variable
const DELAY_MS = 130;

const SERVICE_NAME = "cs-assets-service";
const ACCOUNTS_KEY = "cs-assets-stored-accounts"; // you can rename these if you want
const DEVICE_TOKEN_KEY = "cs-assets-device-token";


let lastReceivedToken = null;

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
  });

  mainWindow.loadFile("index.html");
  mainWindow.webContents.openDevTools(); // For debugging
}

//app.whenReady().then(createWindow);

app.whenReady().then(async () => {
  createWindow();

  // Validate all tokens on startup
  await validateAllStoredTokens();

  // Then fetch accounts from Flask if we have a device token
  try {
    const deviceToken = await keytar.getPassword(
      SERVICE_NAME,
      DEVICE_TOKEN_KEY
    );
    if (deviceToken) {
      await fetchAndUpdateAccountsFromFlask(deviceToken);
    }
  } catch (err) {
    logger(`Error fetching accounts on startup: ${err.message}`);
  }
});

async function fetchAndUpdateAccountsFromFlask(deviceToken) {
  try {
    const serverUrl =
      "https://cs-assets-oskarkohlenprath.pythonanywhere.com/api/desktop_steam_accounts";
    const resp = await axios.post(serverUrl, { device_token: deviceToken });
    const steamAccounts = resp.data.steam_accounts || [];
    logger(`Flask returned ${steamAccounts.length} steam accounts.`);

    // Load current accounts
    const existingAccounts = await loadAccountsJSON();
    const updatedAccounts = [...existingAccounts];

    // Process accounts from Flask API
    for (const flaskAccount of steamAccounts) {
      const steamId = flaskAccount.steam_id;
      const displayName = flaskAccount.persona_name || steamId;
      const avatarUrl =
        flaskAccount.avatar_url || "https://via.placeholder.com/64";

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
    logger(`Error fetching accounts from Flask: ${err.message}`);
    throw err;
  }
}

ipcMain.handle("get-saved-accounts", async () => {
  // 1) Fetch all accounts from Keytar
  const allAccounts = await getAllAccounts();

  // 2) Filter out those that have no (or empty) refreshToken
  const onlyWithToken = allAccounts.filter((acct) => {
    return acct.refreshToken && acct.refreshToken.trim() !== "";
  });

  return onlyWithToken;
});

async function loadAccountsJSON() {
  const existing = await keytar.getPassword(SERVICE_NAME, ACCOUNTS_KEY);
  if (!existing) {
    // No data stored yet
    return [];
  }
  try {
    return JSON.parse(existing);
  } catch (err) {
    console.error("Error parsing stored accounts JSON:", err);
    return [];
  }
}

async function saveAccountsJSON(accounts) {
  const json = JSON.stringify(accounts);
  await keytar.setPassword(SERVICE_NAME, ACCOUNTS_KEY, json);
}

async function getAllAccounts() {
  // Reads the entire array from keytar
  return await loadAccountsJSON();
}

async function saveAccountData({
  steamId,
  displayName,
  refreshToken,
  isRegistered,
}) {
  try {
    const accounts = await loadAccountsJSON();

    // If we're saving a non-empty refresh token, verify it's unique
    if (refreshToken && refreshToken.trim() !== "") {
      // First verify the token belongs to this account
      const tokenSteamId = extractSteamIdFromToken(refreshToken);

      if (tokenSteamId && tokenSteamId !== steamId) {
        logger(
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
        logger(
          `WARNING: Token uniqueness violation detected. Token already exists for account ${
            existingWithToken.displayName || existingWithToken.steamId
          }`
        );

        // Remove the token from the other account
        logger(
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
      // Update existing
      accounts[idx].displayName = displayName;
      accounts[idx].refreshToken = refreshToken;
      accounts[idx].lastUsed = Date.now();
      // Only update isRegistered if provided
      if (typeof isRegistered !== "undefined") {
        accounts[idx].isRegistered = isRegistered;
      }
    } else {
      // Add new
      accounts.push({
        steamId,
        displayName,
        refreshToken,
        lastUsed: Date.now(),
        isRegistered:
          typeof isRegistered !== "undefined" ? isRegistered : false,
      });
    }

    await saveAccountsJSON(accounts);

    // If this was a token update, send notification to the user
    if (refreshToken && refreshToken.trim() !== "") {
      mainWindow?.webContents.send(
        "login-warning",
        `Refresh token updated for account ${displayName || steamId}`
      );
    }
  } catch (err) {
    console.error("Error saving account data to keytar:", err);
    mainWindow?.webContents.send("storage-error", err.toString());
  }
}

// ------------------------------------------------------------
//   IPC handlers for Refresh-Token-based logins
// ------------------------------------------------------------

//ipcMain.handle('get-saved-accounts', async () => {
//  return await getAllAccounts();
//});

// Updated refresh-token login handler
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
    
    // The post-login account validation happens in the loggedOn event
    mainWindow.webContents.send('login-success');
  } catch (error) {
    console.error('Login with refresh token failed:', error);
    mainWindow.webContents.send('login-failed', error.toString());
  }
});




ipcMain.handle('move-items-from-storage', async (_event, payload) => {
  try {
    await performMoves(payload);         // see next section
    return { success: true };
  } catch (err) {
    logger(`move-items failed: ${err.message}`);
    return { success: false, error: err.toString() };
  }
});




// Listen for login credentials from the renderer (username & password)
ipcMain.on('login-credentials', async (event, credentials) => {
  try {
    await terminateSteamSession();
    await initCSGO(credentials);
    mainWindow.webContents.send('login-success');
  } catch (error) {
    console.error('Login failed:', error);
    mainWindow.webContents.send('login-failed', error.toString());
  }
});

// Fetch all storage units (caskets)

ipcMain.on("fetch-storage", async () => {
  try {
    const caskets = await fetchAllCaskets();
    mainWindow.webContents.send("storage-items", caskets);
    // Get the current Steam account id from the logged-in user.
    const steamAccountId = user.steamID.getSteamID64();
    // Now send the caskets to the Flask endpoint.
    try {
      const serverResponse = await sendStorageUnitsToServer(
        caskets,
        steamAccountId
      );
      logger(`Storage units sent to server: ${JSON.stringify(serverResponse)}`);
    } catch (serverErr) {
      logger(`Error sending storage units to server: ${serverErr.message}`);
    }
  } catch (error) {
    console.error("Error fetching storage units:", error);
    mainWindow.webContents.send("storage-error", error.toString());
  }
});

// ---------------------------------------------------------------------
// Configuration / Constants
// ---------------------------------------------------------------------
const MAX_INVENTORY_SIZE = 1000;
const MAX_CASKET_SIZE = 1000;
const INVENTORY_BUFFER = 0;
const SAFE_INVENTORY_SIZE = MAX_INVENTORY_SIZE - INVENTORY_BUFFER;

// -------------------------------------------
// Deep-Check-Funktion (Chunkbasiert)
// -------------------------------------------
ipcMain.on("casket-deep-check", async (event, casketId) => {
  const startTime = Date.now();

  try {
    logger(`Starting deep-check on storage unit ${casketId}...`);

    // 1) Fetch old local web inventory
    logger("Fetching old web inventory...");
    const oldInventory = await getWebInventory();
    const oldInventoryCount = oldInventory.length;
    logger(`Got old web inventory: ${oldInventoryCount} items.`);

    // Potential "space" items (tradable, CS:GO)
    const candidateSpaceItems = oldInventory
      .filter((it) => it.tradable && it.appid === 730)
      .map((it) => it.assetid);
    logger(
      `Found ${candidateSpaceItems.length} tradable CS:GO items in old inventory.`
    );

    // 2) Get casket contents
    logger(`Getting storage unit ${casketId} contents...`);
    const casketItems = await fetchCasketContents(casketId);
    logger(`Storage unit ${casketId} has ${casketItems.length} item(s).`);

    logger(casketItems);

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
      mainWindow.webContents.send("deep-check-progress", {
        progress,
        currentMovement,
        totalMovements,
      });
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
              logger(
                `Chunk too big. Reducing chunk size to ${chunkSize} and retrying...`
              );
            } else {
              throw new Error(
                "Weder Inventar noch Casket haben genug Platz. Abbruch."
              );
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
              logger(
                `No more space-items. Reducing chunk size to ${chunkSize} and retrying...`
              );
            } else {
              throw new Error(
                "Keine Space-Items mehr und Inventar ist zu voll. Abbruch."
              );
            }
            break;
          }
          logger(
            `Moving space-item ${itemToMove} -> casket ${casketId} to free a slot.`
          );
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
        logger(`Removing item ${gcItem.id} from storage unit ${casketId}...`);
        csgo.removeFromCasket(casketId, gcItem.id);
        await delay(DELAY_MS);

        currentInventorySize++;
        currentCasketSize--;
        updateProgress(1);
      }

      // 3) Refresh local web inventory
      logger(
        `Fetching new web inventory after removing ${batch.length} item(s)...`
      );
      const newInventory = await getWebInventory();
      logger(`Got new web inventory: ${newInventory.length} items.`);

      // 3.1) We want to detect items that weren't in oldInventory
      const oldIdsSet = new Set(oldInventory.map((it) => it.assetid));
      const rawNewlyAdded = newInventory.filter(
        (it) => !oldIdsSet.has(it.assetid)
      );

      // 3.2) Transform each newly added item to ensure we pass relevant fields
      // like assetid, classid, instanceid, market_hash_name, icon_url, etc.
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
      logger(`Found ${mappedNewlyAdded.length} new item(s) in inventory.`);
      updateProgress(1);

      // 4) Put items back into casket
      for (const gcItem of batch) {
        logger(`Putting item ${gcItem.id} back to casket ${casketId}...`);
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
      logger(
        `Moving ${temporarilyMovedIntoCasket.length} space-item(s) back to main inventory...`
      );
    }
    const returnBatchSize = 200;
    for (
      let i = 0;
      i < temporarilyMovedIntoCasket.length;
      i += returnBatchSize
    ) {
      const batch = temporarilyMovedIntoCasket.slice(i, i + returnBatchSize);
      for (const itemId of batch) {
        if (currentInventorySize >= SAFE_INVENTORY_SIZE) {
          throw new Error(
            "Inventory unexpectedly full while returning space-items."
          );
        }
        logger(`Returning space item ${itemId} to main inventory...`);
        csgo.removeFromCasket(casketId, itemId);
        await delay(DELAY_MS);

        currentInventorySize++;
        currentCasketSize--;
        updateProgress(1);
      }
    }

    // Finished
    const totalMs = Date.now() - startTime;
    logger(`Deep-check complete. Total time: ${totalMs} ms.`);

    // Finally, send these newlyAddedItems to your Flask endpoint
    const steamAccountId = user.steamID.getSteamID64();
    try {
      const serverResponse = await sendNewItemsToServer(
        casketId,
        newlyAddedItems,
        steamAccountId
      );
      logger(`Server response: ${JSON.stringify(serverResponse)}`);
    } catch (serverErr) {
      logger(`Error sending new items to server: ${serverErr.message}`);
      // We'll still proceed with reporting the deep-check to the UI
    }

    mainWindow.webContents.send("deep-check-result", {
      success: true,
      newlyAddedItems,
      totalTimeMs: totalMs,
      estimatedSeconds: Math.round(totalMs / 1000),
    });
  } catch (error) {
    console.error("Error in deep-check operation:", error);
    logger(`Error: ${error.message || error}`);
    const totalMs = Date.now() - startTime;
    logger(`Deep-check ended with error. Time: ${totalMs} ms.`);

    mainWindow.webContents.send("deep-check-result", {
      success: false,
      error: error.toString(),
      totalTimeMs: totalMs,
    });
  }
});

// ---------------------------------------------------------------------
// Additional Functions
// ---------------------------------------------------------------------

async function sendNewItemsToServer(casketId, newlyAddedItems, steamAccountId) {
  try {
    const serverUrl =
      "http://cs-assets-oskarkohlenprath.pythonanywhere.com/api/register_storage_items";
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
    logger(`Server response: ${JSON.stringify(resp.data)}`);
    return resp.data;
  } catch (err) {
    logger(`Error sending new items to server: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------------------
// HELPER METHODS
// ---------------------------------------------------------------------

async function sendStorageUnitsToServer(caskets, steamAccountId) {
  try {
    const serverUrl =
      "http://cs-assets-oskarkohlenprath.pythonanywhere.com/api/register_storage_units";
    // Prepare payload: include steam_account_id and an array of storage unit objects.
    const payload = {
      steam_account_id: steamAccountId,
      storage_units: caskets.map((casket) => ({
        storage_unit_id: casket.casketId,
        name: casket.casketName,
        // Optionally include other fields such as itemCount if needed.
      })),
    };
    const resp = await axios.post(serverUrl, payload, {
      withCredentials: true,
    });
    if (!resp.data.success) {
      throw new Error(resp.data.error || "Unknown error from server");
    }
    logger(`Storage units registered: ${JSON.stringify(resp.data)}`);
    return resp.data;
  } catch (err) {
    logger(`Error sending storage units to server: ${err.message}`);
    throw err;
  }
}


async function initCSGO(credentials) {
  return new Promise((resolve, reject) => {
    if (user && csgo && csgo.haveGCSession) {
      logger('Already logged in with an active GC session.');
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
        logger("Got an empty refresh token from steam-user");
        return;
      }
      
      logger(`Received new refresh token from Steam: ${token}`);
      lastReceivedToken = token; // Just store it for later use
    });

    // On successful login, handle token saving
    user.on("loggedOn", async () => {
      const steamId = user.steamID.getSteamID64();
      logger(`Logged in as ${steamId}`);
      
      user.setPersona(SteamUser.EPersonaState.Online);
      user.gamesPlayed([730]);

      // Determine which token to use - either the one we just received or the one from credentials
      let finalToken = lastReceivedToken;
      if (!finalToken && credentials.refreshToken) {
        finalToken = credentials.refreshToken;
        logger(`Using token from credentials: ${finalToken}`);
      }

      // Handle device token
      let dt = await keytar.getPassword(SERVICE_NAME, DEVICE_TOKEN_KEY);
      if (!dt) {
        try {
          dt = await ensureDeviceToken(steamId);
          logger(`Device token is confirmed: ${dt}`);
        } catch (err) {
          logger('Error ensuring device token: ' + err);
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
              isRegistered: true
            });
            
            // Also check if this token is duplicated in other accounts and remove it
            await removeTokenFromOtherAccounts(finalToken, steamId);
          }

          mainWindow.webContents.send('account-details', {
            steamId,
            displayName: loggedInAccount.displayName,
            avatarUrl: loggedInAccount.avatarUrl || 'https://via.placeholder.com/64'
          });

          // ── NEW: ask Flask what we still need in live inventory ─────────────
          try {
          await checkInventoryNeeds(steamId);
          } catch (err) {
          logger(`inventory-needs check failed: ${err.message}`);
          }
          




        } else {
          // Not a registered account
          logger(`Account ${steamId} not found in Flask accounts list`);
          
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

          mainWindow.webContents.send('account-details', {
            steamId,
            displayName: credentials.username || steamId,
            avatarUrl: 'https://via.placeholder.com/64'
          });
          
          mainWindow.webContents.send('login-warning', 
            `This account is not linked to your cs-assets.com profile.`);
        }
      } catch (err) {
        logger(`Error during account processing: ${err.message}`);
        
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

    // Other event handlers remain the same
    user.on("webSession", (sessionID, cookies) => {
      logger(`Obtained web session: ${sessionID}`);
      community.setCookies(cookies);
    });

    user.on("steamGuard", (domain, callback) => {
      logger(`SteamGuard code required for domain: ${domain}`);
      if (mainWindow) {
        mainWindow.webContents.send("steamGuard-required", domain);
        ipcMain.once("steamGuard-code", (_event, code) => {
          logger(`Received SteamGuard code from renderer: ${code}`);
          callback(code);
        });
      } else {
        reject(new Error("Main window not available for SteamGuard prompt."));
      }
    });

    user.on("error", (err) => {
      logger(`Steam user error: ${err}`);
      reject(err);
    });

    csgo.on("connectedToGC", () => {
      logger("Connected to GC.");
      resolve();
    });

    csgo.on("disconnectedFromGC", (reason) => {
      logger(`Disconnected from GC: ${reason}`);
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

async function removeTokenFromOtherAccounts(token, exceptSteamId) {
  if (!token) return;
  
  try {
    const accounts = await getAllAccounts();
    let hasChanges = false;
    
    for (const account of accounts) {
      if (account.steamId !== exceptSteamId && account.refreshToken === token) {
        logger(`Removing duplicate token from account ${account.displayName || account.steamId}`);
        account.refreshToken = '';
        hasChanges = true;
      }
    }
    
    if (hasChanges) {
      await saveAccountsJSON(accounts);
    }
  } catch (err) {
    logger(`Error removing duplicate tokens: ${err.message}`);
  }
}


async function getWebInventory() {
  logger("Fetching web inventory...");
  return new Promise((resolve, reject) => {
    community.getUserInventoryContents(
      user.steamID,
      730,
      2,
      false,
      (err, inventory) => {
        if (err) {
          logger(`Error fetching inventory: ${err}`);
          return reject(err);
        }
        logger(`Inventory fetched. Count = ${inventory.length}`);
        resolve(inventory);
      }
    );
  });
}

async function fetchAllCaskets() {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (!csgo.inventory || csgo.inventory.length === 0) {
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

async function fetchCasketContents(casketId) {
  return new Promise((resolve, reject) => {
    csgo.getCasketContents(casketId, (err, items) => {
      if (err) return reject(err);
      resolve(items);
    });
  });
}

async function waitForOriginalItemsRemoved(
  casketId,
  originalIds,
  retries = 10
) {
  for (let i = 0; i < retries; i++) {
    const contents = await fetchCasketContents(casketId);

    const stillRemaining = contents.filter((cItem) =>
      originalIds.includes(cItem.id)
    );
    if (stillRemaining.length === 0) {
      return;
    }
    await delay(DELAY_MS);
  }
  throw new Error("Some original items did not get removed in time.");
}

function logger(msg) {
  console.log("[LOG]", msg);
  if (mainWindow) {
    mainWindow.webContents.send("log-event", msg);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function updateAccountAvatar(steamId, avatarUrl) {
  // We'll load the existing accounts, find the one with steamId, then store avatarUrl there
  const accounts = await loadAccountsJSON();
  const idx = accounts.findIndex((a) => a.steamId === steamId);
  if (idx >= 0) {
    accounts[idx].avatarUrl = avatarUrl;
    accounts[idx].lastUsed = Date.now(); // optional, so it sorts top
    await saveAccountsJSON(accounts);
  }
}

async function ensureDeviceToken(steamId) {
  // 1) Check if Keytar already has a device token
  const existingToken = await keytar.getPassword(
    SERVICE_NAME,
    DEVICE_TOKEN_KEY
  );
  if (existingToken) {
    logger("Device token found in Keytar. No 2FA needed.");
    return existingToken;
  }

  logger("No device token in Keytar. Initiating 2FA flow via Flask...");

  // 2) Make device_token_request
  try {
    // Adjust the URL to your actual endpoint
    await axios.post(
      "https://cs-assets-oskarkohlenprath.pythonanywhere.com/api/device_token_request",
      {
        steam_id: steamId,
      }
    );

    // 3) Prompt user for the 2FA code from their email
    // (Simplest approach is to ask the code from the renderer via an IPC call,
    // or you might do a quick "prompt" in renderer.)
    // For demonstration, we'll do a placeholder:
    const twoFaCode = await promptUserFor2FACodeInRenderer();
    // ^ you'll define how you pass that code from front-end.
    // Possibly do an `ipcMain.handle('device-token-2fa-code', ...)`

    // 4) device_token_confirm
    const confirmResp = await axios.post(
      "https://cs-assets-oskarkohlenprath.pythonanywhere.com/api/device_token_confirm",
      {
        steam_id: steamId,
        code: twoFaCode,
      }
    );

    if (!confirmResp.data || !confirmResp.data.device_token) {
      throw new Error("Flask returned no device_token");
    }
    const newToken = confirmResp.data.device_token;
    logger("Device token obtained from Flask: " + newToken);

    // 5) Store in Keytar
    await keytar.setPassword(SERVICE_NAME, DEVICE_TOKEN_KEY, newToken);
    return newToken;
  } catch (err) {
    if (err.response) {
      // err.response.status is the numeric status code (e.g. 400, 404)
      // err.response.data should contain the JSON from Flask (e.g. { "error": "No steam_account for that steam_id" })
      logger(
        `Error in ensureDeviceToken flow: Status ${
          err.response.status
        } - ${JSON.stringify(err.response.data)}`
      );
    } else {
      // If we never got a response from the server, err.response is undefined.
      logger("Error in ensureDeviceToken flow: " + err.message);
    }
    throw err; // so that higher-level code knows it failed
  }
}

ipcMain.on("2fa-code-submitted", (event, code) => {
  // We'll store the code in a variable? or resolve a promise?
  // We can store it in a Map keyed by event.frameId if multi-requests
  // Or do something simpler with a one-time `once`
});

// We'll define the prompt function:
async function promptUserFor2FACodeInRenderer() {
  return new Promise((resolve) => {
    // Listen once for the code
    ipcMain.once("2fa-code-submitted", (event, code) => {
      resolve(code);
    });
    // Ask renderer to open a modal or prompt:
    mainWindow.webContents.send("please-enter-2fa");
    console.log("send to renderer");
  });
}

function extractSteamIdFromToken(token) {
  if (!token) return null;
  
  try {
    const decoded = jwt_decode(token);
    return decoded.sub || null;
  } catch (err) {
    return null;
  }
}



async function terminateSteamSession() {
  if (!user) return;
  
  logger('Terminating existing Steam session...');
  
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
    
    logger('Session terminated successfully');
  } catch (err) {
    logger(`Error in session termination: ${err.message}`);
    
    // Force new instances
    user = new SteamUser();
    csgo = new GlobalOffensive(user);
  }
}

// Simplified token extraction function







async function validateAllStoredTokens() {
  logger("Validating all stored refresh tokens...");

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
        logger(
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
            logger(
              `Token belongs to ${account.steamId}, clearing from ${firstAccountId}`
            );
            firstAccount.refreshToken = "";
            hasChanges = true;
          } else if (tokenSteamId === firstAccountId) {
            // Clear token from current account
            logger(
              `Token belongs to ${firstAccountId}, clearing from ${account.steamId}`
            );
            account.refreshToken = "";
            hasChanges = true;
          } else {
            // Token doesn't belong to either account
            logger(
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
          logger(
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
          logger(
            `Token for account ${account.steamId} actually belongs to ${tokenSteamId}, clearing`
          );
          account.refreshToken = "";
          hasChanges = true;
        }
      }
    }

    // Save changes if needed
    if (hasChanges) {
      logger(
        "Token validation found and fixed issues, saving updated accounts"
      );
      await saveAccountsJSON(accounts);
    } else {
      logger("Token validation complete, no issues found");
    }
  } catch (err) {
    logger(`Error validating tokens: ${err.message}`);
  }
}






/**
 * Call the Flask /api/inventory_needs/<steam_id> endpoint.
 * If the response contains missing items, notify renderer so it can
 * show a modal.  The actual move operation is started from renderer.
 */
async function checkInventoryNeeds(steamId) {

  console.log("running the api call to inventory needs")

  const url =
    `https://cs-assets-oskarkohlenprath.pythonanywhere.com/api/inventory_needs/${steamId}`;


  console.log(url)


  const { data } = await axios.get(url, { withCredentials: true });


  console.log(url)


  if (!data.success) {
    throw new Error(data.error || 'unknown error');
  }

  const needsSomething =
    data.needed && data.needed.some(n => n.missing > 0 && n.storage_assetids.length);

  if (needsSomething) {
    mainWindow.webContents.send('inventory-needs', data);
  }
}




/**
 * payload = { locked_assetids, needed }   (exactly what Flask sent)
 * Strategy:
 *   – loop over needed[]
 *   – for each storage_assetid: locate its casket, pull it out
 *   – if inventory would overflow: push a not-locked item to ANY casket
 * You already have helpers: fetchAllCaskets, fetchCasketContents,
 * csgo.addToCasket / removeFromCasket.  Re-use them.
 */
async function performMoves({ locked_assetids, needed }) {
  logger('Starting automatic inventory-balancing…');

  // 1.  Make a quick inventory + storage snapshot
  const webInv = await getWebInventory();
  const invSize = webInv.length;

  // 2.  Flatten all asset-ids we must bring into inventory
  const bringIn = needed.flatMap(n => n.storage_assetids.slice(0, n.missing));

  if (bringIn.length === 0) return;          // nothing to do

  // 3.  Make room if necessary
  const projected = invSize + bringIn.length;
  if (projected > SAFE_INVENTORY_SIZE) {
    const overflow = projected - SAFE_INVENTORY_SIZE;
    logger(`Need to park ${overflow} item(s) to storage…`);

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
    // naïve: try every casket until we see it
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
    if (!found) logger(`WARN: could not find assetid ${aid} in any casket`);
  }

  logger('Automatic moves finished.');
}

