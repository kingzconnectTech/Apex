const express = require('express');
const admin = require('firebase-admin');
const path = require('path');
const cron = require('node-cron');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Firebase Admin SDK
// Note: You need to generate a private key file from Firebase Console
// Project Settings > Service accounts > Generate new private key
// Save it as 'serviceAccountKey.json' in this directory
try {
  const serviceAccount = require('./serviceAccountKey.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('Firebase Admin SDK initialized successfully');
} catch (error) {
  console.warn('Firebase Admin SDK not initialized:', error.message);
}

// Basic route
app.get('/', (req, res) => {
  res.send('Apex API is running');
});

// Example route for prediction engine integration
app.post('/api/predict', (req, res) => {
  // This would communicate with the Python Prediction Engine
  // For now, return a mock response
  const { matchId } = req.body;
  res.json({
    matchId,
    prediction: 'Home Win',
    confidence: 0.75,
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Scheduled Job: Add 15 tokens to users with 250+ tokens on the 1st of every month
// Cron pattern: "0 0 1 * *" (At 00:00 on day-of-month 1)
cron.schedule('0 0 1 * *', async () => {
  console.log('Running monthly token distribution job...');
  try {
    const db = admin.firestore();
    const usersRef = db.collection('users');
    
    // Query users with 250 or more tokens
    const snapshot = await usersRef.where('tokens', '>=', 250).get();
    
    if (snapshot.empty) {
      console.log('No eligible users found for monthly tokens.');
      return;
    }

    console.log(`Found ${snapshot.size} users eligible for monthly tokens.`);

    // Batch updates (limit 500 per batch)
    const batchSize = 500;
    const batches = [];
    let batch = db.batch();
    let operationCounter = 0;

    snapshot.docs.forEach((doc) => {
      // Add 15 tokens
      batch.update(doc.ref, {
        tokens: admin.firestore.FieldValue.increment(15)
      });
      
      operationCounter++;

      if (operationCounter === batchSize) {
        batches.push(batch.commit());
        batch = db.batch();
        operationCounter = 0;
      }
    });

    if (operationCounter > 0) {
      batches.push(batch.commit());
    }

    await Promise.all(batches);
    console.log('Monthly token distribution completed successfully.');

  } catch (error) {
    console.error('Error in monthly token distribution job:', error);
  }
});
