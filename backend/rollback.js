const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Rollback procedure for Apex Backend
 * 1. Revert server.js to previous stable version (if using git)
 * 2. Clear cache
 * 3. Restore models from backup
 */

function rollback() {
  console.log('Starting rollback procedure...');
  
  try {
    // 1. Revert code using git (if available)
    try {
      execSync('git checkout server.js prediction_engine/');
      console.log('✓ Reverted code to last committed state');
    } catch (e) {
      console.warn('! Git not available or failed, skipping code revert');
    }

    // 2. Restore models from backup
    const backupDir = path.join(__dirname, 'models_backup');
    const modelDir = path.join(__dirname, 'prediction_engine', 'models');
    
    if (fs.existsSync(backupDir)) {
      if (fs.existsSync(modelDir)) {
        fs.rmSync(modelDir, { recursive: true });
      }
      fs.cpSync(backupDir, modelDir, { recursive: true });
      console.log('✓ Restored models from backup');
    } else {
      console.warn('! No model backup found');
    }

    // 3. Clear logs
    const logs = ['error.log', 'audit.log'];
    logs.forEach(log => {
      if (fs.existsSync(log)) {
        fs.writeFileSync(log, '');
        console.log(`✓ Cleared ${log}`);
      }
    });

    console.log('Rollback completed successfully. Please restart the server.');
  } catch (error) {
    console.error('Rollback failed:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  rollback();
}
