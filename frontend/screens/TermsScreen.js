import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { horizontalScale, verticalScale, moderateScale, getResponsiveFontSize } from '../utils/responsive';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function TermsScreen({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const styles = createStyles(theme, isDarkMode);

  return (
    <View style={styles.container}>
      <SafeAreaView edges={['top']} style={styles.safeHeader}>
        <View style={styles.headerContent}>
            <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
                <Ionicons name="arrow-back" size={24} color={theme.text} />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Terms of Service</Text>
            <View style={{ width: 24 }} />
        </View>
      </SafeAreaView>

      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.lastUpdated}>Last Updated: January 30, 2026</Text>

        <Text style={styles.heading}>1. Acceptance of Terms</Text>
        <Text style={styles.paragraph}>
          By downloading, installing, or using the Apex app ("the App"), you agree to be bound by these Terms of Service. If you do not agree to these terms, please do not use the App.
        </Text>

        <Text style={styles.heading}>2. Description of Service</Text>
        <Text style={styles.paragraph}>
          Apex provides sports predictions and analysis for entertainment purposes only. We do not facilitate real-money gambling. The virtual tokens (APT) used within the app have no real-world monetary value and cannot be exchanged for cash.
        </Text>

        <Text style={styles.heading}>3. User Conduct</Text>
        <Text style={styles.paragraph}>
          You agree not to use the App for any unlawful purpose or in any way that interrupts, damages, or impairs the service. You are responsible for maintaining the confidentiality of your account information.
        </Text>

        <Text style={styles.heading}>4. Virtual Currency (APT)</Text>
        <Text style={styles.paragraph}>
          APT tokens are virtual items with no cash value. They are used solely within the App to access premium features. We reserve the right to modify, suspend, or terminate the virtual currency system at any time without notice or liability.
        </Text>

        <Text style={styles.heading}>5. Disclaimer of Warranties</Text>
        <Text style={styles.paragraph}>
          The App is provided "as is" and "as available" without any warranties of any kind. We do not guarantee the accuracy of predictions or analysis provided by the "Leo" AI assistant.
        </Text>

        <Text style={styles.heading}>6. Limitation of Liability</Text>
        <Text style={styles.paragraph}>
          Apex shall not be liable for any indirect, incidental, special, consequential, or punitive damages resulting from your use of the App.
        </Text>

        <Text style={styles.heading}>7. Changes to Terms</Text>
        <Text style={styles.paragraph}>
          We reserve the right to update these Terms of Service at any time. Your continued use of the App after any changes constitutes your acceptance of the new terms.
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
