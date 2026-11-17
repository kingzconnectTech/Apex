import React, { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { useAdmin } from '../context/AdminContext';
import { horizontalScale, verticalScale, moderateScale, getResponsiveFontSize } from '../utils/responsive';

/**
 * A protected-route wrapper for the administrator experience.
 *
 * The dashboard and every management screen render inside this guard, so a
 * screen is only ever reached AFTER Firebase has confirmed the `admin: true`
 * custom claim. While the claim is being checked a spinner is shown; a
 * non-administrator gets an explicit "no access" message and is redirected to
 * the ordinary user-facing app.
 *
 * The guard is belt-and-braces: Firestore security rules independently refuse
 * every admin write from a non-admin, so this can never be the only defence.
 */
export default function AdminRoute({ navigation, children }) {
  const { theme } = useTheme();
  const { isAdmin, checking } = useAdmin();
  const styles = createStyles(theme);
  const redirectTimer = useRef(null);

  useEffect(() => {
    if (!checking && !isAdmin) {
      // Redirect an unauthorised user back to the normal app, after a short
      // pause so the message is readable.
      redirectTimer.current = setTimeout(() => {
        if (navigation && typeof navigation.navigate === 'function') {
          navigation.navigate('MainTabs');
        }
      }, 2500);
    }
    return () => {
      if (redirectTimer.current) clearTimeout(redirectTimer.current);
    };
  }, [checking, isAdmin, navigation]);

  if (checking) {
    return (
      <View style={[styles.centered, { backgroundColor: theme.bg }]}>
        <ActivityIndicator size="large" color={theme.primary} />
        <Text style={[styles.checkingText, { color: theme.textSecondary }]}>
          Verifying administrator access…
        </Text>
      </View>
    );
  }

  if (!isAdmin) {
    return (
      <View style={[styles.centered, { backgroundColor: theme.bg }]}>
        <Ionicons name="lock-closed-outline" size={moderateScale(56)} color={theme.error} />
        <Text style={[styles.title, { color: theme.text }]}>Access Restricted</Text>
        <Text style={[styles.message, { color: theme.textSecondary }]}>
          This area is for administrators only. Your account does not have administrator
          privileges. You are being returned to the app.
        </Text>
        <TouchableOpacity
          style={[styles.button, { backgroundColor: theme.primary }]}
          onPress={() => navigation && navigation.navigate('MainTabs')}
        >
          <Text style={styles.buttonText}>Back to Home</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return children;
}

const createStyles = theme => StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: horizontalScale(30),
  },
  checkingText: {
    marginTop: verticalScale(15),
    fontSize: getResponsiveFontSize(14),
  },
  title: {
    marginTop: verticalScale(15),
    fontSize: getResponsiveFontSize(22),
    fontWeight: 'bold',
  },
  message: {
    marginTop: verticalScale(10),
    fontSize: getResponsiveFontSize(15),
    textAlign: 'center',
    lineHeight: getResponsiveFontSize(22),
  },
  button: {
    marginTop: verticalScale(25),
    paddingVertical: verticalScale(12),
    paddingHorizontal: horizontalScale(30),
    borderRadius: moderateScale(12),
  },
  buttonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: getResponsiveFontSize(16),
  },
});
