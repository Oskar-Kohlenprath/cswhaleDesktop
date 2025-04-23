// renderer.js

// Listen for login success/failure
window.electronAPI.onLoginSuccess(() => {
  showDashboard();
});
window.electronAPI.onLoginFailed((error) => {
  alert('Login failed: ' + error);
});

// (Optional) Listen for storage items (for debugging)
window.electronAPI.onStorageItems((_, caskets) => {
  console.log('Received storage units:', caskets);
});

// Deep check result and progress events are handled in index.html inline script.

// Listen for storage errors
window.electronAPI.onStorageError((_, error) => {
  alert(`Storage error: ${error}`);
});

// 2FA handling
window.electronAPI.onPleaseEnter2FA(() => {
  document.getElementById('device2faModal').style.display = 'flex';
});

function submitDevice2FACode() {
  const code = document.getElementById('device2faInput').value.trim();
  if (!code) {
    alert('Please enter the 2FA code.');
    return;
  }
  // Send it back to main
  window.electronAPI.send2FACode(code);

  // Reset the modal
  document.getElementById('device2faModal').style.display = 'none';
  document.getElementById('device2faInput').value = '';
}

// New event handler for account-not-registered
window.electronAPI.onAccountNotRegistered((account) => {
  document.getElementById('notRegisteredAccountName').textContent = account.displayName || account.steamId;
  document.getElementById('accountNotRegisteredModal').style.display = 'flex';
});

// Listen for login warnings (e.g., token mismatches that were corrected)
window.electronAPI.onLoginWarning((message) => {
  document.getElementById('warningMessage').textContent = message;
  document.getElementById('warningModal').style.display = 'flex';
});

// Called when the login view is shown or on page load:
async function loadSavedAccounts() {
  try {
    const accounts = await window.electronAPI.getSavedAccounts();
    const container = document.querySelector('.saved-accounts');

    // Clear out everything inside 'saved-accounts' except the <h2> tag
    // so we remove the placeholder accounts.
    const accountItems = container.querySelectorAll('.account-item');
    accountItems.forEach(item => item.remove());

    if (!accounts || accounts.length === 0) {
      container.innerHTML += '<p style="text-align:center;">No saved accounts found.</p>';
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

    // For each account, create a new .account-item div
    sortedAccounts.forEach((acct) => {
      const div = document.createElement('div');
      div.classList.add('account-item');
      
      // Visual indication if account has no valid token
      const hasToken = acct.refreshToken && acct.refreshToken.trim() !== '';
      if (!hasToken) {
        div.classList.add('no-token');
      }
      
      div.onclick = () => {
        if (hasToken) {
          // If it has a token, try to log in automatically
          loginWithSavedAccount(acct.steamId);
        } else {
          // No token - show credential login form with username pre-filled
          document.getElementById('username').value = acct.displayName || '';
          document.getElementById('password').focus();
          // Optionally scroll to the login form
          document.querySelector('.login-form').scrollIntoView({ behavior: 'smooth' });
        }
      };

      div.innerHTML = `
          <div class="account-avatar">
            <img src="${acct.avatarUrl || 'https://via.placeholder.com/40'}" alt="Player avatar">
          </div>
        <div class="account-info">
          <div class="account-name">${acct.displayName || acct.steamId}</div>
          <div class="account-details">
            ${hasToken ? 'Auto login available' : 'Manual login required'}
            ${acct.lastUsed ? ` • Last login: ${new Date(acct.lastUsed).toLocaleString()}` : ''}
          </div>
        </div>
      `;
      container.appendChild(div);
    });
  } catch (err) {
    console.error("Failed to load saved accounts:", err);
  }
}

// Then define the function to handle a click on that user:
function loginWithSavedAccount(steamId) {
  // We'll basically send an IPC call so main does "initCSGO" with the refresh token
  window.electronAPI.loginWithSavedAccount(steamId);
}

// We can call loadSavedAccounts() whenever the #login-view is displayed:
function showLogin() {
  document.getElementById('dashboard-view').style.display = 'none';
  document.getElementById('login-view').style.display = 'block';
  document.getElementById('scanResultModal').style.display = 'none';

  loadSavedAccounts();  // update the "Saved Accounts" block dynamically
}

// Handle account details updates
window.electronAPI.onAccountDetails((_, data) => {
  console.log('[DEBUG renderer.js] Received account-details event with:', data);
  document.getElementById('display-username').textContent = data.displayName;
  document.querySelector('.user-info .account-avatar img').src = data.avatarUrl;
});

// Close modals
function closeNotRegisteredModal() {
  document.getElementById('accountNotRegisteredModal').style.display = 'none';
}

function closeWarningModal() {
  document.getElementById('warningModal').style.display = 'none';
}

// Handle login form submission (regular credential login)
function login() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  
  if (!username || !password) {
    alert('Please enter both username and password.');
    return;
  }
  
  window.electronAPI.login({ username, password });
}