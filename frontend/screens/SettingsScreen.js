import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Switch, Alert } from 'react-native';
import auth from '@react-native-firebase/auth';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../constants/colors';

export default function SettingsScreen({ navigation }) {
  const [isDarkMode, setIsDarkMode] = useState(true); // Default to dark as per new theme
  const user = auth().currentUser;

  const toggleSwitch = () => setIsDarkMode(previousState => !previousState);

  const handleLogout = async () => {
    try {
      await auth().signOut();
    } catch (error) {
      console.error('Error signing out: ', error);
      Alert.alert('Error', 'Failed to sign out. Please try again.');
    }
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete Account',
      'Are you sure you want to delete your account? This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              if (user) {
                await user.delete();
              }
            } catch (error) {
              console.error('Error deleting account: ', error);
              Alert.alert('Error', 'Failed to delete account. You may need to re-login first.');
            }
          },
        },
      ]
    );
  };

  const handleContact = () => {
    Alert.alert('Contact Support', 'Email us at support@apex.com');
  };

  const handlePrivacyPolicy = () => {
    Alert.alert('Privacy Policy', 'Privacy Policy placeholder...');
  };

  // Dynamic styles based on theme (Keeping toggle logic but default base is now dark)
  const themeStyles = {
    container: {
      backgroundColor: isDarkMode ? COLORS.bg : '#f8f9fa',
    },
    text: {
      color: isDarkMode ? COLORS.text : '#333333',
    },
    sectionTitle: {
      color: isDarkMode ? COLORS.secondary : '#666666',
    },
    card: {
      backgroundColor: isDarkMode ? COLORS.cardBg : '#ffffff',
    },
    iconColor: isDarkMode ? COLORS.accent : '#333333',
    separator: {
      backgroundColor: isDarkMode ? COLORS.bg : '#f0f0f0',
    }
  };

  return (
    <ScrollView style={[styles.container, themeStyles.container]}>
      {/* User Profile Section */}
      <View style={[styles.profileSection, themeStyles.card]}>
        <View style={styles.avatarContainer}>
          <Ionicons name="person-circle-outline" size={80} color={COLORS.primary} />
        </View>
        <Text style={[styles.userName, themeStyles.text]}>{user?.displayName || 'User'}</Text>
        <Text style={[styles.userEmail, { color: COLORS.textSecondary }]}>{user?.email || 'No Email'}</Text>
      </View>

      {/* App Preference Section */}
      <Text style={[styles.sectionTitle, themeStyles.sectionTitle]}>App Preferences</Text>
      <View style={[styles.section, themeStyles.card]}>
        <View style={styles.row}>
          <View style={styles.rowLeft}>
            <Ionicons name="moon-outline" size={22} color={themeStyles.iconColor} />
            <Text style={[styles.rowLabel, themeStyles.text]}>Dark Mode</Text>
          </View>
          <Switch
            trackColor={{ false: '#767577', true: COLORS.primary }}
            thumbColor={isDarkMode ? COLORS.accent : '#f4f3f4'}
            ios_backgroundColor="#3e3e3e"
            onValueChange={toggleSwitch}
            value={isDarkMode}
          />
        </View>
      </View>

      {/* Support Section */}
      <Text style={[styles.sectionTitle, themeStyles.sectionTitle]}>Support</Text>
      <View style={[styles.section, themeStyles.card]}>
        <TouchableOpacity style={styles.row} onPress={handleContact}>
          <View style={styles.rowLeft}>
            <Ionicons name="mail-outline" size={22} color={themeStyles.iconColor} />
            <Text style={[styles.rowLabel, themeStyles.text]}>Contact Us</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={COLORS.textSecondary} />
        </TouchableOpacity>
        
        <View style={[styles.separator, themeStyles.separator]} />

        <TouchableOpacity style={styles.row} onPress={handlePrivacyPolicy}>
          <View style={styles.rowLeft}>
            <Ionicons name="shield-checkmark-outline" size={22} color={themeStyles.iconColor} />
            <Text style={[styles.rowLabel, themeStyles.text]}>Privacy Policy</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={COLORS.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* Account Actions Section */}
      <Text style={[styles.sectionTitle, themeStyles.sectionTitle]}>Account</Text>
      <View style={[styles.section, themeStyles.card]}>
        <TouchableOpacity style={styles.row} onPress={handleLogout}>
          <View style={styles.rowLeft}>
            <Ionicons name="log-out-outline" size={22} color={COLORS.error} />
            <Text style={[styles.rowLabel, { color: COLORS.error }]}>Log Out</Text>
          </View>
        </TouchableOpacity>
        
        <View style={[styles.separator, themeStyles.separator]} />

        <TouchableOpacity style={styles.row} onPress={handleDeleteAccount}>
          <View style={styles.rowLeft}>
            <Ionicons name="trash-outline" size={22} color={COLORS.error} />
            <Text style={[styles.rowLabel, { color: COLORS.error }]}>Delete Account</Text>
          </View>
        </TouchableOpacity>
      </View>
      
      <Text style={[styles.versionText, { color: COLORS.textSecondary }]}>Version 1.0.0</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
  },
  profileSection: {
    alignItems: 'center',
    padding: 20,
    borderRadius: 15,
    marginBottom: 25,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 2,
    borderWidth: 1,
    borderColor: COLORS.primary,
  },
  avatarContainer: {
    marginBottom: 10,
  },
  userName: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 5,
  },
  userEmail: {
    fontSize: 14,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 10,
    marginLeft: 5,
    textTransform: 'uppercase',
  },
  section: {
    borderRadius: 15,
    marginBottom: 25,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 15,
    paddingHorizontal: 20,
  },
  rowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowLabel: {
    fontSize: 16,
    marginLeft: 15,
    fontWeight: '500',
  },
  separator: {
    height: 1,
    width: '100%',
  },
  versionText: {
    textAlign: 'center',
    marginBottom: 30,
    fontSize: 12,
  },
});
