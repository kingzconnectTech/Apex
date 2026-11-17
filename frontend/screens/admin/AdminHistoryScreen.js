import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import { horizontalScale, verticalScale, moderateScale, getResponsiveFontSize } from '../../utils/responsive';
import AdminPickCard from '../../components/AdminPickCard';
import { subscribeAllPicks } from '../../services/adminPicks';
import {
  STATUS,
  formatMatchDateTime,
  normalizeStatus,
  statusLabel,
  statusToneColor,
  summarizePicks,
  sortPicks,
} from '../../utils/adminPicksView';

const HISTORY_FILTERS = ['All', STATUS.WON, STATUS.LOST, STATUS.VOID];

/**
 * Prediction History — every prediction an administrator has settled, with a
 * result summary and a settled-by / settled-at record for accountability.
 */
export default function AdminHistoryScreen() {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  const [picks, setPicks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('All');

  useEffect(() => {
    const unsubscribe = subscribeAllPicks(
      list => { setPicks(list); setLoading(false); },
      err => {
        setError(err && err.message ? err.message : 'Could not load prediction history.');
        setLoading(false);
      },
    );
    return unsubscribe;
  }, []);

  const summary = useMemo(() => summarizePicks(picks), [picks]);
  const settledCount = summary.won + summary.lost + summary.void;
  const decided = summary.won + summary.lost;
  const winRate = decided > 0 ? Math.round((summary.won / decided) * 100) : null;

  const history = useMemo(() => {
    const settled = picks.filter(p => normalizeStatus(p && p.status) !== STATUS.PENDING);
    const scoped = filter === 'All'
      ? settled
      : settled.filter(p => normalizeStatus(p.status) === filter);
    return sortPicks(scoped);
  }, [picks, filter]);

  if (loading) {
    return (
      <View style={[styles.centered, { backgroundColor: theme.bg }]}>
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  const renderFooter = (item) => {
    const when = formatMatchDateTime(item.settledAt);
    if (!when && !item.settledBy) return null;
    return (
      <View style={styles.settledMeta}>
        <Ionicons name="shield-checkmark-outline" size={moderateScale(13)} color={theme.textSecondary} />
        <Text style={[styles.settledMetaText, { color: theme.textSecondary }]} numberOfLines={1}>
          Settled{when ? ` ${when.date} ${when.time}` : ''}
          {item.settledBy ? ` · by ${item.settledBy}` : ''}
        </Text>
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      {/* Result summary */}
      <View style={[styles.summaryCard, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
        <View style={styles.summaryRow}>
          <SummaryStat label="Settled" value={settledCount} color={theme.text} styles={styles} />
          <SummaryStat label="Won" value={summary.won} color={theme.success} styles={styles} />
          <SummaryStat label="Lost" value={summary.lost} color={theme.error} styles={styles} />
          <SummaryStat label="Void" value={summary.void} color={theme.textSecondary} styles={styles} />
        </View>
        <Text style={[styles.winRate, { color: theme.textSecondary }]}>
          {winRate == null ? 'No decided predictions yet' : `Strike rate ${winRate}% (won / decided)`}
          {'  ·  '}
          {summary.pending} still pending
        </Text>
      </View>

      {/* Result filters */}
      <FlatList
        horizontal
        data={HISTORY_FILTERS}
        keyExtractor={item => item}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.filterRow}
        renderItem={({ item }) => {
          const active = filter === item;
          const tint = item === 'All' ? theme.primary : statusToneColor(theme, item);
          return (
            <TouchableOpacity
              onPress={() => setFilter(item)}
              style={[
                styles.chip,
                {
                  backgroundColor: active ? tint : theme.cardBg,
                  borderColor: active ? tint : theme.border,
                },
              ]}
            >
              <Text style={[styles.chipText, { color: active ? '#FFFFFF' : theme.textSecondary }]}>
                {item === 'All' ? 'All results' : statusLabel(item)}
              </Text>
            </TouchableOpacity>
          );
        }}
      />

      {error ? (
        <View style={[styles.errorBox, { borderColor: theme.error }]}>
          <Text style={{ color: theme.error }}>{error}</Text>
        </View>
      ) : null}

      <FlatList
        data={history}
        keyExtractor={(item, index) => item.id || String(index)}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => (
          <View>
            <AdminPickCard pick={item} showVisibility />
            {renderFooter(item)}
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="time-outline" size={moderateScale(48)} color={theme.textSecondary} />
            <Text style={[styles.emptyTitle, { color: theme.text }]}>No settled predictions</Text>
            <Text style={[styles.emptyText, { color: theme.textSecondary }]}>
              Results appear here once an administrator settles a prediction.
            </Text>
          </View>
        }
      />
    </View>
  );
}

function SummaryStat({ label, value, color, styles }) {
  return (
    <View style={styles.summaryStat}>
      <Text style={[styles.summaryValue, { color }]}>{value}</Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

const createStyles = theme => StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  summaryCard: {
    borderWidth: 1,
    borderRadius: moderateScale(14),
    margin: moderateScale(16),
    marginBottom: verticalScale(8),
    padding: moderateScale(16),
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  summaryStat: {
    alignItems: 'center',
    flex: 1,
  },
  summaryValue: {
    fontSize: getResponsiveFontSize(24),
    fontWeight: '800',
  },
  summaryLabel: {
    fontSize: getResponsiveFontSize(12),
    color: theme.textSecondary,
    marginTop: verticalScale(2),
    fontWeight: '600',
  },
  winRate: {
    marginTop: verticalScale(12),
    fontSize: getResponsiveFontSize(12),
    textAlign: 'center',
  },
  filterRow: {
    paddingHorizontal: horizontalScale(16),
    paddingVertical: verticalScale(6),
  },
  chip: {
    borderWidth: 1,
    borderRadius: moderateScale(16),
    paddingHorizontal: horizontalScale(14),
    paddingVertical: verticalScale(6),
    marginRight: horizontalScale(8),
  },
  chipText: {
    fontSize: getResponsiveFontSize(12),
    fontWeight: '600',
  },
  errorBox: {
    borderWidth: 1,
    borderRadius: moderateScale(10),
    padding: moderateScale(12),
    marginHorizontal: horizontalScale(16),
    marginTop: verticalScale(8),
  },
  listContent: {
    padding: moderateScale(16),
    paddingBottom: verticalScale(40),
  },
  settledMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: verticalScale(-8),
    marginBottom: verticalScale(16),
    paddingHorizontal: horizontalScale(4),
  },
  settledMetaText: {
    marginLeft: horizontalScale(6),
    fontSize: getResponsiveFontSize(11),
    flexShrink: 1,
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: verticalScale(70),
  },
  emptyTitle: {
    marginTop: verticalScale(12),
    fontSize: getResponsiveFontSize(17),
    fontWeight: '700',
  },
  emptyText: {
    marginTop: verticalScale(6),
    fontSize: getResponsiveFontSize(13),
    textAlign: 'center',
    paddingHorizontal: horizontalScale(30),
  },
});
