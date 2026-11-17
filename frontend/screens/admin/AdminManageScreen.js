import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useTheme } from '../../context/ThemeContext';
import { horizontalScale, verticalScale, moderateScale, getResponsiveFontSize } from '../../utils/responsive';
import AdminPickCard from '../../components/AdminPickCard';
import {
  subscribeAllPicks,
  deletePick,
  publishPick,
  unpublishPick,
  settlePick,
} from '../../services/adminPicks';
import {
  SPORTS,
  STATUS,
  STATUSES,
  VISIBILITY,
  normalizeStatus,
  statusLabel,
  pickMatchesSearch,
  applyManageFilters,
  leagueOptions,
  sortPicks,
} from '../../utils/adminPicksView';

const SPORT_FILTERS = ['All', ...SPORTS];
const STATUS_FILTERS = ['All', ...STATUSES];

/**
 * Manage every administrator prediction: search, filter, edit, publish /
 * unpublish, settle results and delete.
 *
 * Result settlement is manual and always confirmed when it would overwrite an
 * already-settled prediction. Nothing here is computed automatically.
 */
export default function AdminManageScreen({ navigation }) {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  const [picks, setPicks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const [search, setSearch] = useState('');
  const [sportFilter, setSportFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState('All');
  const [leagueFilter, setLeagueFilter] = useState('All');
  const [dateFilter, setDateFilter] = useState(null);
  const [showDatePicker, setShowDatePicker] = useState(false);

  useEffect(() => {
    const unsubscribe = subscribeAllPicks(
      list => { setPicks(list); setLoading(false); },
      err => {
        setError(err && err.message ? err.message : 'Could not load predictions.');
        setLoading(false);
      },
    );
    return unsubscribe;
  }, []);

  const leagues = useMemo(() => leagueOptions(picks), [picks]);

  const visible = useMemo(() => {
    const filtered = applyManageFilters(picks, {
      sport: sportFilter,
      league: leagueFilter,
      status: statusFilter,
      date: dateFilter,
    });
    return sortPicks(filtered.filter(p => pickMatchesSearch(p, search)));
  }, [picks, sportFilter, leagueFilter, statusFilter, dateFilter, search]);

  /** Run an async mutation with a per-card busy flag and error surfacing. */
  const run = async (id, action) => {
    setBusyId(id);
    try {
      const result = await action();
      if (!result.ok) {
        Alert.alert('Action failed', result.message || 'Please try again.');
      }
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = (pick) => {
    Alert.alert(
      'Delete prediction',
      `Delete "${pick.homeTeam} vs ${pick.awayTeam}"? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => run(pick.id, () => deletePick(pick.id)),
        },
      ],
    );
  };

  const applyStatus = (pick, next) => {
    run(pick.id, () => settlePick(pick.id, next));
  };

  const onSelectStatus = (pick, next) => {
    const current = normalizeStatus(pick.status);
    if (current === next) return;
    const currentSettled = current !== STATUS.PENDING;
    const overwriting = currentSettled && next !== current;
    if (overwriting) {
      Alert.alert(
        'Overwrite result?',
        `This prediction is already marked "${statusLabel(current)}". Change it to "${statusLabel(next)}"?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Change', style: 'destructive', onPress: () => applyStatus(pick, next) },
        ],
      );
      return;
    }
    applyStatus(pick, next);
  };

  const toggleVisibility = (pick) => {
    if (pick.visibility === VISIBILITY.PUBLISHED) {
      run(pick.id, () => unpublishPick(pick.id));
    } else {
      run(pick.id, () => publishPick(pick.id));
    }
  };

  const renderCard = ({ item }) => {
    const busy = busyId === item.id;
    const current = normalizeStatus(item.status);
    const published = item.visibility === VISIBILITY.PUBLISHED;
    return (
      <View>
        <AdminPickCard pick={item} showVisibility />

        <View style={[styles.actions, { borderColor: theme.border, backgroundColor: theme.cardBg }]}>
          {/* Status setters */}
          <Text style={[styles.actionsLabel, { color: theme.textSecondary }]}>Set result</Text>
          <View style={styles.statusRow}>
            {STATUSES.map(s => {
              const active = current === s;
              return (
                <TouchableOpacity
                  key={s}
                  disabled={busy}
                  onPress={() => onSelectStatus(item, s)}
                  style={[
                    styles.statusChip,
                    {
                      backgroundColor: active ? theme.primary : theme.bg,
                      borderColor: active ? theme.primary : theme.border,
                    },
                  ]}
                >
                  <Text style={[styles.statusChipText, { color: active ? '#FFFFFF' : theme.textSecondary }]}>
                    {statusLabel(s)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <View style={styles.actionButtons}>
            <TouchableOpacity
              style={[styles.smallButton, { borderColor: theme.border }]}
              disabled={busy}
              onPress={() => navigation.navigate('AdminUpload', { pick: item })}
            >
              <Ionicons name="create-outline" size={moderateScale(16)} color={theme.text} />
              <Text style={[styles.smallButtonText, { color: theme.text }]}>Edit</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.smallButton, { borderColor: theme.border }]}
              disabled={busy}
              onPress={() => toggleVisibility(item)}
            >
              <Ionicons
                name={published ? 'eye-off-outline' : 'cloud-upload-outline'}
                size={moderateScale(16)}
                color={theme.text}
              />
              <Text style={[styles.smallButtonText, { color: theme.text }]}>
                {published ? 'Unpublish' : 'Publish'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.smallButton, { borderColor: theme.error }]}
              disabled={busy}
              onPress={() => confirmDelete(item)}
            >
              <Ionicons name="trash-outline" size={moderateScale(16)} color={theme.error} />
              <Text style={[styles.smallButtonText, { color: theme.error }]}>Delete</Text>
            </TouchableOpacity>
          </View>

          {busy ? (
            <View style={styles.busyOverlay}>
              <ActivityIndicator color={theme.primary} />
            </View>
          ) : null}
        </View>
      </View>
    );
  };

  if (loading) {
    return (
      <View style={[styles.centered, { backgroundColor: theme.bg }]}>
        <ActivityIndicator size="large" color={theme.primary} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      {/* Search */}
      <View style={[styles.searchBox, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
        <Ionicons name="search" size={moderateScale(18)} color={theme.textSecondary} />
        <TextInput
          style={[styles.searchInput, { color: theme.text }]}
          value={search}
          onChangeText={setSearch}
          placeholder="Search by team name"
          placeholderTextColor={theme.textSecondary}
        />
        {search ? (
          <TouchableOpacity onPress={() => setSearch('')}>
            <Ionicons name="close-circle" size={moderateScale(18)} color={theme.textSecondary} />
          </TouchableOpacity>
        ) : null}
      </View>

      {/* Filters */}
      <View style={styles.filterBlock}>
        <FlatList
          horizontal
          data={SPORT_FILTERS}
          keyExtractor={item => `sport-${item}`}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
          renderItem={({ item }) => (
            <FilterChip
              label={item}
              active={sportFilter === item}
              theme={theme}
              styles={styles}
              onPress={() => setSportFilter(item)}
            />
          )}
        />
        <FlatList
          horizontal
          data={STATUS_FILTERS}
          keyExtractor={item => `status-${item}`}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterRow}
          renderItem={({ item }) => (
            <FilterChip
              label={item === 'All' ? 'All statuses' : statusLabel(item)}
              active={statusFilter === item}
              theme={theme}
              styles={styles}
              onPress={() => setStatusFilter(item)}
            />
          )}
        />
        <View style={styles.filterRow}>
          <FlatList
            horizontal
            data={['All', ...leagues]}
            keyExtractor={item => `league-${item}`}
            showsHorizontalScrollIndicator={false}
            renderItem={({ item }) => (
              <FilterChip
                label={item === 'All' ? 'All leagues' : item}
                active={leagueFilter === item}
                theme={theme}
                styles={styles}
                onPress={() => setLeagueFilter(item)}
              />
            )}
          />
        </View>
        <View style={styles.dateFilterRow}>
          <TouchableOpacity
            style={[styles.dateChip, { backgroundColor: theme.cardBg, borderColor: theme.border }]}
            onPress={() => setShowDatePicker(true)}
          >
            <Ionicons name="calendar-outline" size={moderateScale(15)} color={theme.secondary} />
            <Text style={[styles.dateChipText, { color: theme.text }]}>
              {dateFilter ? dateFilter.toDateString() : 'Filter by date'}
            </Text>
          </TouchableOpacity>
          {dateFilter ? (
            <TouchableOpacity onPress={() => setDateFilter(null)} style={styles.clearDate}>
              <Ionicons name="close-circle" size={moderateScale(20)} color={theme.textSecondary} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {showDatePicker && (
        <DateTimePicker
          value={dateFilter || new Date()}
          mode="date"
          display="default"
          onChange={(event, selected) => {
            if (Platform.OS !== 'ios') setShowDatePicker(false);
            if (selected) setDateFilter(selected);
          }}
        />
      )}

      {error ? (
        <View style={[styles.errorBox, { borderColor: theme.error }]}>
          <Text style={{ color: theme.error }}>{error}</Text>
        </View>
      ) : null}

      <FlatList
        data={visible}
        keyExtractor={(item, index) => item.id || String(index)}
        contentContainerStyle={styles.listContent}
        renderItem={renderCard}
        ListHeaderComponent={
          <Text style={[styles.countText, { color: theme.textSecondary }]}>
            {visible.length} prediction{visible.length === 1 ? '' : 's'}
          </Text>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="folder-open-outline" size={moderateScale(48)} color={theme.textSecondary} />
            <Text style={[styles.emptyTitle, { color: theme.text }]}>No predictions</Text>
            <Text style={[styles.emptyText, { color: theme.textSecondary }]}>
              {picks.length === 0
                ? 'Upload a prediction to get started.'
                : 'No predictions match the current filters.'}
            </Text>
          </View>
        }
      />
    </View>
  );
}

function FilterChip({ label, active, onPress, theme, styles }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[
        styles.chip,
        {
          backgroundColor: active ? theme.primary : theme.cardBg,
          borderColor: active ? theme.primary : theme.border,
        },
      ]}
    >
      <Text style={[styles.chipText, { color: active ? '#FFFFFF' : theme.textSecondary }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const createStyles = theme => StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: moderateScale(10),
    marginHorizontal: horizontalScale(16),
    marginTop: verticalScale(14),
    paddingHorizontal: horizontalScale(12),
  },
  searchInput: {
    flex: 1,
    paddingVertical: verticalScale(10),
    paddingHorizontal: horizontalScale(8),
    fontSize: getResponsiveFontSize(15),
  },
  filterBlock: {
    paddingTop: verticalScale(10),
    paddingBottom: verticalScale(4),
  },
  filterRow: {
    paddingHorizontal: horizontalScale(16),
    paddingVertical: verticalScale(4),
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
  dateFilterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: horizontalScale(16),
    paddingVertical: verticalScale(6),
  },
  dateChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: moderateScale(10),
    paddingHorizontal: horizontalScale(12),
    paddingVertical: verticalScale(8),
  },
  dateChipText: {
    marginLeft: horizontalScale(8),
    fontSize: getResponsiveFontSize(13),
  },
  clearDate: {
    marginLeft: horizontalScale(8),
  },
  errorBox: {
    borderWidth: 1,
    borderRadius: moderateScale(10),
    padding: moderateScale(12),
    marginHorizontal: horizontalScale(16),
    marginTop: verticalScale(10),
  },
  listContent: {
    padding: moderateScale(16),
    paddingBottom: verticalScale(40),
  },
  countText: {
    fontSize: getResponsiveFontSize(12),
    marginBottom: verticalScale(10),
  },
  actions: {
    borderWidth: 1,
    borderRadius: moderateScale(12),
    padding: moderateScale(12),
    marginTop: verticalScale(-6),
    marginBottom: verticalScale(16),
  },
  actionsLabel: {
    fontSize: getResponsiveFontSize(11),
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: verticalScale(8),
  },
  statusRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: verticalScale(10),
  },
  statusChip: {
    borderWidth: 1,
    borderRadius: moderateScale(14),
    paddingHorizontal: horizontalScale(12),
    paddingVertical: verticalScale(5),
    marginRight: horizontalScale(8),
    marginBottom: verticalScale(6),
  },
  statusChipText: {
    fontSize: getResponsiveFontSize(12),
    fontWeight: '600',
  },
  actionButtons: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  smallButton: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: moderateScale(10),
    paddingHorizontal: horizontalScale(12),
    paddingVertical: verticalScale(8),
    marginRight: horizontalScale(8),
    marginBottom: verticalScale(4),
  },
  smallButtonText: {
    marginLeft: horizontalScale(6),
    fontSize: getResponsiveFontSize(13),
    fontWeight: '600',
  },
  busyOverlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.15)',
    borderRadius: moderateScale(12),
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
  },
});
