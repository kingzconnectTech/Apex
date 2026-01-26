const express = require('express');
const admin = require('firebase-admin');
const path = require('path');

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
