import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { horizontalScale, verticalScale, moderateScale, getResponsiveFontSize } from '../utils/responsive';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function PrivacyPolicyScreen({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const styles = createStyles(theme, isDarkMode);

  return (
    <View style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safeHeader}>
        <View style={styles.headerContent}>
            <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
                <Ionicons name="arrow-back" size={24} color={theme.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Privacy Policy</Text>
            <View style={{ width: 24 }} />
        </View>
      </SafeAreaView>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.lastUpdated}>Last Updated: January 30, 2026</Text>

        <Text style={styles.heading}>1. Introduction</Text>
        <Text style={styles.paragraph}>
          Apex ("we", "our", or "us") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, and safeguard your information when you use our mobile application.
        </Text>

        <Text style={styles.heading}>2. Information We Collect</Text>
        <Text style={styles.paragraph}>
          We collect information you provide directly to us, such as when you create an account, update your profile, or communicate with us. This may include your name, email address, and date of birth.
        </Text>
        <Text style={styles.paragraph}>
          We also automatically collect certain information when you use the app, including usage details, device information, and IP address.
        </Text>

        <Text style={styles.heading}>3. How We Use Your Information</Text>
        <Text style={styles.paragraph}>
          We use the information we collect to:
          {'\n'}• Provide, maintain, and improve our services
          {'\n'}• Process transactions and manage your virtual currency (APT)
          {'\n'}• Send you technical notices, updates, and support messages
          {'\n'}• Respond to your comments and questions
        </Text>

        <Text style={styles.heading}>4. Data Security</Text>
        <Text style={styles.paragraph}>
          We implement reasonable security measures to protect your personal information. However, no method of transmission over the internet or electronic storage is 100% secure, and we cannot guarantee absolute security.
        </Text>

        <Text style={styles.heading}>5. Third-Party Services</Text>
        <Text style={styles.paragraph}>
          Our app may contain links to third-party websites or services (e.g., Google AdMob) that are not owned or controlled by us. We are not responsible for the privacy practices of such third parties.
        </Text>

        <Text style={styles.heading}>6. Children's Privacy</Text>
        <Text style={styles.paragraph}>
          Our services are not intended for individuals under the age of 18. We do not knowingly collect personal information from children. If we become aware that we have collected personal information from a child, we will take steps to delete such information.
        </Text>

        <Text style={styles.heading}>7. Changes to This Policy</Text>
        <Text style={styles.paragraph}>
          We may update this Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy on this page and updating the "Last Updated" date.
        </Text>

        <Text style={styles.heading}>8. Contact Us</Text>
        <Text style={styles.paragraph}>
          If you have any questions about this Privacy Policy, please contact us through the "Contact Us" section in the app settings.
        </Text>
        
        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const createStyles = (theme, isDarkMode) => StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.bg,
  },
  safeHeader: {
    backgroundColor: theme.bg,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  headerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: moderateScale(20),
    paddingVertical: verticalScale(15),
  },
  headerTitle: {
    color: theme.text,
    fontSize: getResponsiveFontSize(18),
    fontWeight: 'bold',
  },
  backBtn: {
    padding: 5,
  },
  content: {
    padding: moderateScale(20),
  },
  lastUpdated: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(12),
    marginBottom: verticalScale(20),
    fontStyle: 'italic',
  },
  heading: {
    color: theme.text,
    fontSize: getResponsiveFontSize(16),
    fontWeight: 'bold',
    marginTop: verticalScale(15),
    marginBottom: verticalScale(8),
  },
  paragraph: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(14),
    lineHeight: verticalScale(22),
    marginBottom: verticalScale(10),
  },
});
