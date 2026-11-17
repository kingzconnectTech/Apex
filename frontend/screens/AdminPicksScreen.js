import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { horizontalScale, verticalScale, moderateScale, getResponsiveFontSize } from '../utils/responsive';
import { GlobalBannerAd } from '../components/GlobalBannerAd';
import AdminPickCard from '../components/AdminPickCard';
import { subscribePublishedPicks } from '../services/adminPicks';
import { FILTERS, applyUserFilter, sortPicks } from '../utils/adminPicksView';

/**
 * ADMIN PICKS — the user-facing screen.
 *
 * It shows EXCLUSIVELY predictions an administrator uploaded to the dedicated
 * `admin_predictions` collection. It never reads the AI prediction engine, never
 * mixes in engine output, and only ever receives documents whose visibility is
 * `published` (the Firestore query is constrained to that, and the security
 * rules refuse drafts to non-admins).
 *
 * A real-time listener keeps it current: an upload, edit or settlement shows up
 * here without the user refreshing.
 */
export default function AdminPicksScreen() {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  const [picks, setPicks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const unsubscribe = subscribePublishedPicks(
      (list) => {
        setPicks(list);
        setLoading(false);
      },
      (err) => {
        setError(err && err.message ? err.message : 'Could not load admin picks.');
        setLoading(false);
      },
    );
    return unsubscribe;
  }, [reloadKey]);

  const visible = useMemo(
    () => sortPicks(applyUserFilter(picks, filter)),
    [picks, filter],
  );

  if (loading) {
    return (
      <View style={[styles.centered, { backgroundColor: theme.bg }]}>
        <ActivityIndicator size="large" color={theme.primary} />
        <Text style={[styles.stateText, { color: theme.textSecondary }]}>Loading admin picks…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.centered, { backgroundColor: theme.bg }]}>
        <Ionicons name="cloud-offline-outline" size={moderateScale(48)} color={theme.error} />
        <Text style={[styles.stateTitle, { color: theme.text }]}>Something went wrong</Text>
        <Text style={[styles.stateText, { color: theme.textSecondary }]}>{error}</Text>
        <TouchableOpacity
          style={[styles.retryButton, { backgroundColor: theme.primary }]}
          onPress={() => setReloadKey(k => k + 1)}
        >
          <Text style={styles.retryText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      {/* Filter chips */}
      <View style={styles.filterBar}>
        <FlatList
          horizontal
          data={FILTERS}
          keyExtractor={item => item.key}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterList}
          renderItem={({ item }) => {
            const active = filter === item.key;
            return (
              <TouchableOpacity
                onPress={() => setFilter(item.key)}
                style={[
                  styles.chip,
                  {
                    backgroundColor: active ? theme.primary : theme.cardBg,
                    borderColor: active ? theme.primary : theme.border,
                  },
                ]}
              >
                <Text style={[styles.chipText, { color: active ? '#FFFFFF' : theme.textSecondary }]}>
                  {item.label}
                </Text>
              </TouchableOpacity>
            );
          }}
        />
      </View>

      <FlatList
        data={visible}
        keyExtractor={(item, index) => item.id || String(index)}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => <AdminPickCard pick={item} />}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => setReloadKey(k => k + 1)}
            tintColor={theme.primary}
          />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="trophy-outline" size={moderateScale(48)} color={theme.textSecondary} />
            <Text style={[styles.stateTitle, { color: theme.text }]}>No admin picks yet</Text>
            <Text style={[styles.stateText, { color: theme.textSecondary }]}>
              {picks.length === 0
                ? 'When an administrator publishes a prediction it will appear here.'
                : 'No predictions match this filter.'}
            </Text>
          </View>
        }
      />

      <GlobalBannerAd />
    </View>
  );
}

const createStyles = theme => StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: horizontalScale(30),
  },
  stateTitle: {
    marginTop: verticalScale(12),
    fontSize: getResponsiveFontSize(18),
    fontWeight: '700',
  },
  stateText: {
    marginTop: verticalScale(8),
    fontSize: getResponsiveFontSize(14),
    textAlign: 'center',
    lineHeight: getResponsiveFontSize(20),
  },
  retryButton: {
    marginTop: verticalScale(20),
    paddingVertical: verticalScale(12),
    paddingHorizontal: horizontalScale(28),
    borderRadius: moderateScale(12),
  },
  retryText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: getResponsiveFontSize(15),
  },
  filterBar: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.border,
  },
  filterList: {
    paddingHorizontal: horizontalScale(15),
    paddingVertical: verticalScale(12),
  },
  chip: {
    paddingHorizontal: horizontalScale(16),
    paddingVertical: verticalScale(8),
    borderRadius: moderateScale(20),
    borderWidth: 1,
    marginRight: horizontalScale(8),
  },
  chipText: {
    fontSize: getResponsiveFontSize(13),
    fontWeight: '600',
  },
  listContent: {
    padding: moderateScale(15),
    paddingBottom: verticalScale(30),
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: verticalScale(80),
    paddingHorizontal: horizontalScale(30),
  },
});
