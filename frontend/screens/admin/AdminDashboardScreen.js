import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import { horizontalScale, verticalScale, moderateScale, getResponsiveFontSize } from '../../utils/responsive';
import { subscribeAllPicks } from '../../services/adminPicks';
import { summarizePicks } from '../../utils/adminPicksView';

/**
 * The administrator dashboard: summary counts over every uploaded prediction and
 * navigation into the four admin sections.
 */
export default function AdminDashboardScreen({ navigation }) {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  const [picks, setPicks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const unsubscribe = subscribeAllPicks(
      (list) => { setPicks(list); setLoading(false); },
      (err) => {
        setError(err && err.message ? err.message : 'Could not load predictions.');
        setLoading(false);
      },
    );
    return unsubscribe;
  }, []);

  const summary = useMemo(() => summarizePicks(picks), [picks]);

  const cards = [
    { key: 'total', label: 'Total Uploaded', value: summary.total, icon: 'layers-outline', color: theme.primary },
    { key: 'pending', label: 'Pending', value: summary.pending, icon: 'time-outline', color: theme.accent },
    { key: 'won', label: 'Won', value: summary.won, icon: 'checkmark-circle', color: theme.success },
    { key: 'lost', label: 'Lost', value: summary.lost, icon: 'close-circle', color: theme.error },
    { key: 'void', label: 'Void', value: summary.void, icon: 'remove-circle', color: theme.textSecondary },
  ];

  const sections = [
    { key: 'dashboard', label: 'Dashboard Overview', icon: 'grid-outline', route: 'AdminDashboard' },
    { key: 'upload', label: 'Upload Prediction', icon: 'cloud-upload-outline', route: 'AdminUpload' },
    { key: 'manage', label: 'Manage Predictions', icon: 'list-outline', route: 'AdminManage' },
    { key: 'history', label: 'Prediction History', icon: 'time-outline', route: 'AdminHistory' },
  ];

  if (loading) {
    return (
      <View style={[styles.centered, { backgroundColor: theme.bg }]}>
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.bg }} contentContainerStyle={styles.content}>
      {error ? (
        <View style={[styles.errorBox, { borderColor: theme.error }]}>
          <Text style={{ color: theme.error }}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.summaryGrid}>
        {cards.map(card => (
          <View key={card.key} style={[styles.summaryCard, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
            <Ionicons name={card.icon} size={moderateScale(22)} color={card.color} />
            <Text style={[styles.summaryValue, { color: theme.text }]}>{card.value}</Text>
            <Text style={[styles.summaryLabel, { color: theme.textSecondary }]}>{card.label}</Text>
          </View>
        ))}
      </View>

      <View style={[styles.draftNote, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
        <Ionicons name="document-text-outline" size={moderateScale(16)} color={theme.secondary} />
        <Text style={[styles.draftNoteText, { color: theme.textSecondary }]}>
          {summary.published} published · {summary.draft} draft
        </Text>
      </View>

      <Text style={[styles.sectionTitle, { color: theme.secondary }]}>Sections</Text>
      <View style={[styles.navList, { backgroundColor: theme.cardBg }]}>
        {sections.map((section, index) => (
          <React.Fragment key={section.key}>
            <TouchableOpacity
              style={styles.navRow}
              onPress={() => navigation.navigate(section.route)}
            >
              <View style={styles.navLeft}>
                <Ionicons name={section.icon} size={moderateScale(22)} color={theme.icon} />
                <Text style={[styles.navLabel, { color: theme.text }]}>{section.label}</Text>
              </View>
              <Ionicons name="chevron-forward" size={moderateScale(20)} color={theme.textSecondary} />
            </TouchableOpacity>
            {index < sections.length - 1 && <View style={[styles.separator, { backgroundColor: theme.bg }]} />}
          </React.Fragment>
        ))}
      </View>
    </ScrollView>
  );
}

const createStyles = theme => StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    padding: moderateScale(15),
    paddingBottom: verticalScale(40),
  },
  errorBox: {
    borderWidth: 1,
    borderRadius: moderateScale(10),
    padding: moderateScale(12),
    marginBottom: verticalScale(15),
  },
  summaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  summaryCard: {
    width: '48%',
    borderRadius: moderateScale(14),
    borderWidth: 1,
    padding: moderateScale(16),
    marginBottom: verticalScale(12),
  },
  summaryValue: {
    fontSize: getResponsiveFontSize(28),
    fontWeight: '800',
    marginTop: verticalScale(8),
  },
  summaryLabel: {
    fontSize: getResponsiveFontSize(13),
    fontWeight: '600',
    marginTop: verticalScale(2),
  },
  draftNote: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: moderateScale(12),
    padding: moderateScale(12),
    marginBottom: verticalScale(20),
  },
  draftNoteText: {
    marginLeft: horizontalScale(8),
    fontSize: getResponsiveFontSize(13),
  },
  sectionTitle: {
    fontSize: getResponsiveFontSize(14),
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: verticalScale(10),
    marginLeft: horizontalScale(4),
  },
  navList: {
    borderRadius: moderateScale(15),
    overflow: 'hidden',
  },
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: verticalScale(16),
    paddingHorizontal: horizontalScale(18),
  },
  navLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  navLabel: {
    fontSize: getResponsiveFontSize(16),
    fontWeight: '500',
    marginLeft: horizontalScale(15),
  },
  separator: {
    height: 1,
    width: '100%',
  },
});
