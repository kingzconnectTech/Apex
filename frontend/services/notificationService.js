import messaging from '@react-native-firebase/messaging';
import firestore from '@react-native-firebase/firestore';
import { Platform } from 'react-native';

export async function requestUserPermission() {
  const authStatus = await messaging().requestPermission();
  const enabled =
    authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
    authStatus === messaging.AuthorizationStatus.PROVISIONAL;

  if (enabled) {
    console.log('Authorization status:', authStatus);
  }
  return enabled;
}

export async function getFcmToken() {
  try {
    const fcmToken = await messaging().getToken();
    if (fcmToken) {
      console.log('Your Firebase Token is:', fcmToken);
      return fcmToken;
    } else {
      console.log('Failed', 'No token received');
      return null;
    }
  } catch (error) {
    console.log('Failed to get FCM token:', error);
    return null;
  }
}

export async function saveTokenToDatabase(userId) {
  if (!userId) return;

  // 1. Request permission
  const hasPermission = await requestUserPermission();
  if (!hasPermission) return;

  // 2. Get token
  const token = await getFcmToken();
  if (!token) return;

  // 3. Save to Firestore
  try {
    const userRef = firestore().collection('users').doc(userId);
    
    // We use arrayUnion to add the token without duplicating if it exists
    await userRef.update({
        fcmTokens: firestore.FieldValue.arrayUnion(token)
    });
    console.log('FCM Token saved to database');
    
  } catch (error) {
    console.error('Error saving FCM token:', error);
  }
}
