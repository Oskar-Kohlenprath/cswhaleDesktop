

const keytar = require('keytar');

const SERVICE_NAME = 'cs-assets-service'; // or whatever name you've been using

async function deleteAllKeytarData() {
  // keytar.findCredentials(serviceName) returns an array of { account, password } objects
  const allCredentials = await keytar.findCredentials(SERVICE_NAME);

  for (const cred of allCredentials) {
    // cred.account is the “key” in Keytar
    await keytar.deletePassword(SERVICE_NAME, cred.account);
  }

  console.log(`Deleted ${allCredentials.length} credentials from keytar for ${SERVICE_NAME}`);
}




async function printAllKeytarData() {
    try {
      // Retrieve an array of { account, password } objects for the specified service
      const allCredentials = await keytar.findCredentials(SERVICE_NAME);
  
      if (allCredentials.length === 0) {
        console.log(`No credentials found for service: ${SERVICE_NAME}`);
        return;
      }
  
      console.log(`Found ${allCredentials.length} credential(s) for service: ${SERVICE_NAME}:`);
  
      // Loop over each credential and print the account and corresponding password.
      for (const { account, password } of allCredentials) {
        console.log(`Account: ${account}, Password: ${password}`);
      }
    } catch (error) {
      // Log detailed error information in case of a failure
      console.error(`An error occurred while retrieving credentials for ${SERVICE_NAME}:`, error);
    }
  }
  
  // Execute the function
 printAllKeytarData();





//deleteAllKeytarData();








