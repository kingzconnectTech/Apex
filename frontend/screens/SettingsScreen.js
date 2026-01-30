import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Switch, Alert, Modal, Linking, TouchableWithoutFeedback } from 'react-native';
import auth from '@react-native-firebase/auth';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { horizontalScale, verticalScale, moderateScale, getResponsiveFontSize } from '../utils/responsive';
import { GlobalBannerAd } from '../components/GlobalBannerAd';

export default function SettingsScreen({ navigation }) {
  const { theme, isDarkMode, toggleTheme } = useTheme();
  const styles = createStyles(theme, isDarkMode);
  const user = auth().currentUser;
  const [contactModalVisible, setContactModalVisible] = React.useState(false);

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
    setContactModalVisible(true);
  };

  const openLink = async (url) => {
    try {
      const supported = await Linking.canOpenURL(url);
      if (supported) {
        await Linking.openURL(url);
      } else {
        await Linking.openURL(url);
      }
    } catch (err) {
      console.error('An error occurred', err);
      Alert.alert('Error', 'Could not open the link.');
    }
    setContactModalVisible(false);
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView style={[styles.container, { backgroundColor: theme.bg }]}>
        {/* User Profile Section */}
        <View style={[styles.profileSection, { backgroundColor: theme.cardBg, borderColor: theme.primary }]}>
          <View style={styles.avatarContainer}>
            <Ionicons name="person-circle-outline" size={moderateScale(80)} color={theme.primary} />
          </View>
          <Text style={[styles.userName, { color: theme.text }]}>{user?.displayName || 'User'}</Text>
          <Text style={[styles.userEmail, { color: theme.textSecondary }]}>{user?.email || 'No Email'}</Text>
        </View>

        {/* App Preference Section */}
        <Text style={[styles.sectionTitle, { color: theme.secondary }]}>App Preferences</Text>
        <View style={[styles.section, { backgroundColor: theme.cardBg }]}>
          <View style={styles.row}>
            <View style={styles.rowLeft}>
              <Ionicons name="moon-outline" size={moderateScale(22)} color={theme.icon} />
              <Text style={[styles.rowLabel, { color: theme.text }]}>Dark Mode</Text>
            </View>
            <Switch
              trackColor={{ false: '#767577', true: theme.primary }}
              thumbColor={isDarkMode ? theme.accent : '#f4f3f4'}
              ios_backgroundColor="#3e3e3e"
              onValueChange={toggleTheme}
              value={isDarkMode}
            />
          </View>
        </View>

        {/* Support Section */}
        <Text style={[styles.sectionTitle, { color: theme.secondary }]}>Support</Text>
        <View style={[styles.section, { backgroundColor: theme.cardBg }]}>
          <TouchableOpacity style={styles.row} onPress={handleContact}>
            <View style={styles.rowLeft}>
              <Ionicons name="mail-outline" size={moderateScale(22)} color={theme.icon} />
              <Text style={[styles.rowLabel, { color: theme.text }]}>Contact Us</Text>
            </View>
            <Ionicons name="chevron-forward" size={moderateScale(20)} color={theme.textSecondary} />
          </TouchableOpacity>
          
          <View style={[styles.separator, { backgroundColor: theme.bg }]} />

          <TouchableOpacity style={styles.row} onPress={() => navigation.navigate('PrivacyPolicy')}>
            <View style={styles.rowLeft}>
              <Ionicons name="shield-checkmark-outline" size={moderateScale(22)} color={theme.icon} />
              <Text style={[styles.rowLabel, { color: theme.text }]}>Privacy Policy</Text>
            </View>
            <Ionicons name="chevron-forward" size={moderateScale(20)} color={theme.textSecondary} />
          </TouchableOpacity>

          <View style={[styles.separator, { backgroundColor: theme.bg }]} />

          <TouchableOpacity style={styles.row} onPress={() => navigation.navigate('Terms')}>
            <View style={styles.rowLeft}>
              <Ionicons name="document-text-outline" size={moderateScale(22)} color={theme.icon} />
              <Text style={[styles.rowLabel, { color: theme.text }]}>Terms of Service</Text>
            </View>
            <Ionicons name="chevron-forward" size={moderateScale(20)} color={theme.textSecondary} />
          </TouchableOpacity>
        </View>

        {/* Account Actions Section */}
        <Text style={[styles.sectionTitle, { color: theme.secondary }]}>Account</Text>
        <View style={[styles.section, { backgroundColor: theme.cardBg }]}>
          <TouchableOpacity style={styles.row} onPress={handleLogout}>
            <View style={styles.rowLeft}>
              <Ionicons name="log-out-outline" size={moderateScale(22)} color={theme.error} />
              <Text style={[styles.rowLabel, { color: theme.error }]}>Log Out</Text>
            </View>
          </TouchableOpacity>
          
          <View style={[styles.separator, { backgroundColor: theme.bg }]} />

          <TouchableOpacity style={styles.row} onPress={handleDeleteAccount}>
            <View style={styles.rowLeft}>
              <Ionicons name="trash-outline" size={moderateScale(22)} color={theme.error} />
              <Text style={[styles.rowLabel, { color: theme.error }]}>Delete Account</Text>
            </View>
          </TouchableOpacity>
        </View>
        
        <Text style={[styles.versionText, { color: theme.textSecondary }]}>Version 1.0.0</Text>
      </ScrollView>
      
      {/* Contact Modal */}
      <Modal
        animationType="fade"
        transparent={true}
        visible={contactModalVisible}
        onRequestClose={() => setContactModalVisible(false)}
      >
        <TouchableWithoutFeedback onPress={() => setContactModalVisible(false)}>
          <View style={styles.modalOverlay}>
            <TouchableWithoutFeedback>
              <View style={[styles.modalContent, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
                <Text style={[styles.modalTitle, { color: theme.text }]}>Contact Us</Text>
                
                <TouchableOpacity 
                  style={[styles.contactOption, { borderBottomColor: theme.border, borderBottomWidth: 1 }]} 
                  onPress={() => openLink('mailto:apexprediction01@gmail.com')}
                >
                  <Ionicons name="mail" size={moderateScale(24)} color={theme.primary} />
                  <Text style={[styles.contactOptionText, { color: theme.text }]}>Email Support</Text>
                </TouchableOpacity>

                <TouchableOpacity 
                  style={styles.contactOption} 
                  onPress={() => openLink('https://wa.me/gr/FUTOXBPIVAY4J1')}
                >
                  <Ionicons name="logo-whatsapp" size={moderateScale(24)} color="#25D366" />
                  <Text style={[styles.contactOptionText, { color: theme.text }]}>WhatsApp Support</Text>
                </TouchableOpacity>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      <GlobalBannerAd />
    </View>
  );
}

const createStyles = (theme, isDarkMode) => StyleSheet.create({
  container: {
    flex: 1,
    padding: moderateScale(20),
  },
  profileSection: {
    alignItems: 'center',
    padding: moderateScale(20),
    borderRadius: moderateScale(15),
    marginBottom: verticalScale(25),
    shadowColor: '#000',
    shadowOffset: { width: 0, height: verticalScale(2) },
    shadowOpacity: 0.1,
    shadowRadius: moderateScale(3),
    elevation: 2,
    borderWidth: 1,
    borderColor: theme.primary,
  },
  avatarContainer: {
    marginBottom: verticalScale(10),
  },
  userName: {
    fontSize: getResponsiveFontSize(20),
    fontWeight: 'bold',
    marginBottom: verticalScale(5),
  },
  userEmail: {
    fontSize: getResponsiveFontSize(14),
  },
  sectionTitle: {
    fontSize: getResponsiveFontSize(14),
    fontWeight: '600',
    marginBottom: verticalScale(10),
    marginLeft: horizontalScale(5),
    textTransform: 'uppercase',
  },
  section: {
    borderRadius: moderateScale(15),
    marginBottom: verticalScale(25),
    shadowColor: '#000',
    shadowOffset: { width: 0, height: verticalScale(1) },
    shadowOpacity: 0.1,
    shadowRadius: moderateScale(2),
    elevation: 2,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: verticalScale(15),
    paddingHorizontal: horizontalScale(20),
  },
  rowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowLabel: {
    fontSize: getResponsiveFontSize(16),
    marginLeft: horizontalScale(15),
    fontWeight: '500',
  },
  separator: {
    height: 1,
    width: '100%',
  },
  versionText: {
    textAlign: 'center',
    marginBottom: verticalScale(30),
    fontSize: getResponsiveFontSize(12),
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: '85%',
    borderRadius: moderateScale(20),
    padding: moderateScale(25),
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
    borderWidth: 1,
  },
  modalTitle: {
    fontSize: getResponsiveFontSize(20),
    fontWeight: 'bold',
    marginBottom: verticalScale(20),
  },
  contactOption: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    paddingVertical: verticalScale(15),
  },
  contactOptionText: {
    fontSize: getResponsiveFontSize(16),
    marginLeft: horizontalScale(15),
    fontWeight: '500',
  },
});
