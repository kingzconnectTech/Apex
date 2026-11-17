import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
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
import { createPick, updatePick, subscribeAllPicks } from '../../services/adminPicks';
import {
  SPORTS,
  MARKET_OPTIONS,
  LIMITS,
  VISIBILITY,
  CONFIDENCE_MIN,
  CONFIDENCE_MAX,
  formatMatchDateTime,
  isDuplicatePick,
  pickToForm,
  statusLabel,
} from '../../utils/adminPicksView';

/** A blank form. Match date defaults to now so the picker opens somewhere sane. */
function emptyForm() {
  return {
    sport: SPORTS[0],
    league: '',
    homeTeam: '',
    awayTeam: '',
    matchDate: new Date(),
    market: '',
    selection: '',
    confidence: '',
    analysis: '',
  };
}

/**
 * Upload / edit a single administrator prediction.
 *
 * The same screen serves both roles: with no route param it CREATES a
 * prediction (Save as Draft or Publish), and with a `pick` param it EDITS that
 * prediction's content (leaving status and settlement untouched — those are
 * changed from the Manage screen).
 */
export default function AdminUploadScreen({ navigation, route }) {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  const editingPick = route.params && route.params.pick ? route.params.pick : null;
  const editingId = editingPick ? editingPick.id : null;

  const [form, setForm] = useState(() => (editingPick ? pickToForm(editingPick) : emptyForm()));
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(null); // 'draft' | 'publish' | 'save'
  const [existing, setExisting] = useState([]);
  const [showDate, setShowDate] = useState(false);
  const [showTime, setShowTime] = useState(false);

  // Keep a live list of every prediction so a duplicate can be caught before it
  // is written. Admin-only: rules refuse this query to a non-admin.
  useEffect(() => {
    const unsubscribe = subscribeAllPicks(
      list => setExisting(list),
      () => { /* duplicate detection is best-effort; a failed read must not block the form */ },
    );
    return unsubscribe;
  }, []);

  const setField = (key, value) => {
    setForm(prev => ({ ...prev, [key]: value }));
    setErrors(prev => (prev[key] ? { ...prev, [key]: undefined } : prev));
  };

  const matchDateValue = form.matchDate instanceof Date ? form.matchDate : new Date();
  const when = formatMatchDateTime(form.matchDate);
  const markets = useMemo(() => MARKET_OPTIONS[form.sport] || [], [form.sport]);

  const onChangeDate = (event, selected) => {
    if (Platform.OS !== 'ios') setShowDate(false);
    if (!selected) return;
    const next = new Date(matchDateValue);
    next.setFullYear(selected.getFullYear(), selected.getMonth(), selected.getDate());
    setField('matchDate', next);
  };

  const onChangeTime = (event, selected) => {
    if (Platform.OS !== 'ios') setShowTime(false);
    if (!selected) return;
    const next = new Date(matchDateValue);
    next.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
    setField('matchDate', next);
  };

  /** Write the pick once validation and duplicate checks pass. */
  const persist = async (mode) => {
    const visibility = mode === 'publish' ? VISIBILITY.PUBLISHED : VISIBILITY.DRAFT;
    setSubmitting(mode);
    try {
      const result = editingId
        ? await updatePick(editingId, form)
        : await createPick(form, { visibility });

      if (!result.ok) {
        if (result.errors) {
          setErrors(result.errors);
          Alert.alert('Check the form', 'Some fields need attention before this can be saved.');
        } else {
          Alert.alert('Could not save', result.message || 'Please try again.');
        }
        return;
      }

      if (editingId) {
        Alert.alert('Saved', 'The prediction was updated.', [
          { text: 'OK', onPress: () => navigation.goBack() },
        ]);
      } else {
        Alert.alert(
          visibility === VISIBILITY.PUBLISHED ? 'Published' : 'Draft saved',
          visibility === VISIBILITY.PUBLISHED
            ? 'This prediction is now visible on the Admin Picks screen.'
            : 'This prediction is saved as a draft and is not visible to users.',
          [
            { text: 'Upload another', onPress: () => { setForm(emptyForm()); setErrors({}); } },
            { text: 'Done', onPress: () => navigation.goBack() },
          ],
        );
      }
    } finally {
      setSubmitting(null);
    }
  };

  const handleSubmit = (mode) => {
    const duplicate = isDuplicatePick(form, existing, { excludeId: editingId });
    if (duplicate && mode !== 'publish') {
      Alert.alert(
        'Possible duplicate',
        'A prediction for these teams, kick-off, market and selection already exists.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Save anyway', onPress: () => persist(mode) },
        ],
      );
      return;
    }
    if (duplicate) {
      Alert.alert(
        'Possible duplicate',
        'A prediction for these teams, kick-off, market and selection already exists. Publish anyway?',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Publish anyway', onPress: () => persist(mode) },
        ],
      );
      return;
    }
    persist(mode);
  };

  const busy = submitting != null;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {editingId ? (
        <View style={[styles.editBanner, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
          <Ionicons name="create-outline" size={moderateScale(16)} color={theme.secondary} />
          <Text style={[styles.editBannerText, { color: theme.textSecondary }]}>
            Editing a {statusLabel(editingPick.status).toLowerCase()} prediction ·{' '}
            {editingPick.visibility === VISIBILITY.PUBLISHED ? 'published' : 'draft'}
          </Text>
        </View>
      ) : null}

      {/* ---------------------------------------------------- match information */}
      <Text style={[styles.sectionTitle, { color: theme.secondary }]}>Match Information</Text>

      <Text style={[styles.label, { color: theme.text }]}>Sport</Text>
      <View style={styles.sportRow}>
        {SPORTS.map(sport => {
          const active = form.sport === sport;
          return (
            <TouchableOpacity
              key={sport}
              onPress={() => setField('sport', sport)}
              style={[
                styles.sportChip,
                {
                  backgroundColor: active ? theme.primary : theme.cardBg,
                  borderColor: active ? theme.primary : theme.border,
                },
              ]}
            >
              <Ionicons
                name={sport === 'Basketball' ? 'basketball-outline' : 'football-outline'}
                size={moderateScale(16)}
                color={active ? '#FFFFFF' : theme.textSecondary}
              />
              <Text style={[styles.sportChipText, { color: active ? '#FFFFFF' : theme.textSecondary }]}>
                {sport}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
      {errors.sport ? <Text style={[styles.error, { color: theme.error }]}>{errors.sport}</Text> : null}

      <Text style={[styles.label, { color: theme.text }]}>League / Competition</Text>
      <TextInput
        style={[styles.input, { backgroundColor: theme.cardBg, borderColor: theme.border, color: theme.text }]}
        value={form.league}
        onChangeText={t => setField('league', t)}
        placeholder="e.g. Premier League"
        placeholderTextColor={theme.textSecondary}
        maxLength={LIMITS.league}
      />
      {errors.league ? <Text style={[styles.error, { color: theme.error }]}>{errors.league}</Text> : null}

      <Text style={[styles.label, { color: theme.text }]}>Home Team</Text>
      <TextInput
        style={[styles.input, { backgroundColor: theme.cardBg, borderColor: theme.border, color: theme.text }]}
        value={form.homeTeam}
        onChangeText={t => setField('homeTeam', t)}
        placeholder="e.g. Arsenal"
        placeholderTextColor={theme.textSecondary}
        maxLength={LIMITS.team}
      />
      {errors.homeTeam ? <Text style={[styles.error, { color: theme.error }]}>{errors.homeTeam}</Text> : null}

      <Text style={[styles.label, { color: theme.text }]}>Away Team</Text>
      <TextInput
        style={[styles.input, { backgroundColor: theme.cardBg, borderColor: theme.border, color: theme.text }]}
        value={form.awayTeam}
        onChangeText={t => setField('awayTeam', t)}
        placeholder="e.g. Chelsea"
        placeholderTextColor={theme.textSecondary}
        maxLength={LIMITS.team}
      />
      {errors.awayTeam ? <Text style={[styles.error, { color: theme.error }]}>{errors.awayTeam}</Text> : null}

      <Text style={[styles.label, { color: theme.text }]}>Match Date & Time</Text>
      <View style={styles.dateRow}>
        <TouchableOpacity
          style={[styles.dateField, { backgroundColor: theme.cardBg, borderColor: theme.border }]}
          onPress={() => setShowDate(true)}
        >
          <Ionicons name="calendar-outline" size={moderateScale(16)} color={theme.secondary} />
          <Text style={[styles.dateText, { color: theme.text }]}>{when ? when.date : 'Select date'}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.timeField, { backgroundColor: theme.cardBg, borderColor: theme.border }]}
          onPress={() => setShowTime(true)}
        >
          <Ionicons name="time-outline" size={moderateScale(16)} color={theme.secondary} />
          <Text style={[styles.dateText, { color: theme.text }]}>{when ? when.time : '--:--'}</Text>
        </TouchableOpacity>
      </View>
      {errors.matchDate ? <Text style={[styles.error, { color: theme.error }]}>{errors.matchDate}</Text> : null}

      {showDate && (
        <DateTimePicker value={matchDateValue} mode="date" display="default" onChange={onChangeDate} />
      )}
      {showTime && (
        <DateTimePicker value={matchDateValue} mode="time" display="default" onChange={onChangeTime} />
      )}

      {/* ------------------------------------------------ prediction information */}
      <Text style={[styles.sectionTitle, { color: theme.secondary, marginTop: verticalScale(20) }]}>
        Prediction Information
      </Text>

      <Text style={[styles.label, { color: theme.text }]}>Prediction Market</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.marketChips}>
        {markets.map(market => {
          const active = form.market === market;
          return (
            <TouchableOpacity
              key={market}
              onPress={() => setField('market', market)}
              style={[
                styles.marketChip,
                {
                  backgroundColor: active ? theme.primary : theme.cardBg,
                  borderColor: active ? theme.primary : theme.border,
                },
              ]}
            >
              <Text style={[styles.marketChipText, { color: active ? '#FFFFFF' : theme.textSecondary }]}>
                {market}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
      <TextInput
        style={[styles.input, { backgroundColor: theme.cardBg, borderColor: theme.border, color: theme.text }]}
        value={form.market}
        onChangeText={t => setField('market', t)}
        placeholder="Type a market (or pick one above)"
        placeholderTextColor={theme.textSecondary}
        maxLength={LIMITS.market}
      />
      {errors.market ? <Text style={[styles.error, { color: theme.error }]}>{errors.market}</Text> : null}

      <Text style={[styles.label, { color: theme.text }]}>Prediction Selection</Text>
      <TextInput
        style={[styles.input, { backgroundColor: theme.cardBg, borderColor: theme.border, color: theme.text }]}
        value={form.selection}
        onChangeText={t => setField('selection', t)}
        placeholder="e.g. Over 1.5 Goals"
        placeholderTextColor={theme.textSecondary}
        maxLength={LIMITS.selection}
      />
      {errors.selection ? <Text style={[styles.error, { color: theme.error }]}>{errors.selection}</Text> : null}

      <Text style={[styles.label, { color: theme.text }]}>Confidence (%)</Text>
      <TextInput
        style={[styles.input, { backgroundColor: theme.cardBg, borderColor: theme.border, color: theme.text }]}
        value={form.confidence}
        onChangeText={t => setField('confidence', t.replace(/[^0-9.]/g, ''))}
        placeholder={`${CONFIDENCE_MIN}–${CONFIDENCE_MAX}`}
        placeholderTextColor={theme.textSecondary}
        keyboardType="numeric"
      />
      {errors.confidence ? <Text style={[styles.error, { color: theme.error }]}>{errors.confidence}</Text> : null}

      <Text style={[styles.label, { color: theme.text }]}>Prediction Analysis</Text>
      <TextInput
        style={[
          styles.input,
          styles.analysisInput,
          { backgroundColor: theme.cardBg, borderColor: theme.border, color: theme.text },
        ]}
        value={form.analysis}
        onChangeText={t => setField('analysis', t)}
        placeholder="Your reasoning for this prediction"
        placeholderTextColor={theme.textSecondary}
        multiline
        maxLength={LIMITS.analysis}
      />
      {errors.analysis ? <Text style={[styles.error, { color: theme.error }]}>{errors.analysis}</Text> : null}

      {/* ------------------------------------------------------------- actions */}
      {editingId ? (
        <TouchableOpacity
          style={[styles.primaryButton, { backgroundColor: theme.primary, opacity: busy ? 0.7 : 1 }]}
          onPress={() => handleSubmit('save')}
          disabled={busy}
        >
          {submitting === 'save' ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <>
              <Ionicons name="save-outline" size={moderateScale(18)} color="#FFFFFF" />
              <Text style={styles.primaryButtonText}>Save Changes</Text>
            </>
          )}
        </TouchableOpacity>
      ) : (
        <View style={styles.actionRow}>
          <TouchableOpacity
            style={[styles.secondaryButton, { borderColor: theme.primary, opacity: busy ? 0.7 : 1 }]}
            onPress={() => handleSubmit('draft')}
            disabled={busy}
          >
            {submitting === 'draft' ? (
              <ActivityIndicator color={theme.primary} />
            ) : (
              <>
                <Ionicons name="document-outline" size={moderateScale(18)} color={theme.primary} />
                <Text style={[styles.secondaryButtonText, { color: theme.primary }]}>Save Draft</Text>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.primaryButton, styles.flexButton, { backgroundColor: theme.primary, opacity: busy ? 0.7 : 1 }]}
            onPress={() => handleSubmit('publish')}
            disabled={busy}
          >
            {submitting === 'publish' ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <>
                <Ionicons name="cloud-upload-outline" size={moderateScale(18)} color="#FFFFFF" />
                <Text style={styles.primaryButtonText}>Publish</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

const createStyles = theme => StyleSheet.create({
  content: {
    padding: moderateScale(16),
    paddingBottom: verticalScale(50),
  },
  editBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: moderateScale(10),
    padding: moderateScale(10),
    marginBottom: verticalScale(16),
  },
  editBannerText: {
    marginLeft: horizontalScale(8),
    fontSize: getResponsiveFontSize(12),
  },
  sectionTitle: {
    fontSize: getResponsiveFontSize(14),
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: verticalScale(12),
    marginLeft: horizontalScale(2),
  },
  label: {
    fontSize: getResponsiveFontSize(13),
    fontWeight: '600',
    marginBottom: verticalScale(6),
    marginLeft: horizontalScale(2),
  },
  input: {
    borderWidth: 1,
    borderRadius: moderateScale(10),
    paddingHorizontal: horizontalScale(14),
    paddingVertical: verticalScale(12),
    fontSize: getResponsiveFontSize(15),
    marginBottom: verticalScale(14),
  },
  analysisInput: {
    minHeight: verticalScale(110),
    textAlignVertical: 'top',
  },
  error: {
    fontSize: getResponsiveFontSize(12),
    marginTop: verticalScale(-8),
    marginBottom: verticalScale(10),
    marginLeft: horizontalScale(2),
  },
  sportRow: {
    flexDirection: 'row',
    marginBottom: verticalScale(14),
  },
  sportChip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: moderateScale(10),
    paddingVertical: verticalScale(12),
    marginRight: horizontalScale(10),
  },
  sportChipText: {
    marginLeft: horizontalScale(6),
    fontSize: getResponsiveFontSize(14),
    fontWeight: '600',
  },
  dateRow: {
    flexDirection: 'row',
  },
  dateField: {
    flex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: moderateScale(10),
    paddingHorizontal: horizontalScale(14),
    paddingVertical: verticalScale(14),
    marginRight: horizontalScale(10),
  },
  timeField: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: moderateScale(10),
    paddingHorizontal: horizontalScale(14),
    paddingVertical: verticalScale(14),
    marginBottom: verticalScale(14),
  },
  dateText: {
    marginLeft: horizontalScale(8),
    fontSize: getResponsiveFontSize(14),
  },
  marketChips: {
    marginBottom: verticalScale(10),
  },
  marketChip: {
    borderWidth: 1,
    borderRadius: moderateScale(20),
    paddingHorizontal: horizontalScale(14),
    paddingVertical: verticalScale(8),
    marginRight: horizontalScale(8),
  },
  marketChipText: {
    fontSize: getResponsiveFontSize(12),
    fontWeight: '600',
  },
  actionRow: {
    flexDirection: 'row',
    marginTop: verticalScale(10),
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.primary,
    borderRadius: moderateScale(12),
    paddingVertical: verticalScale(15),
    marginTop: verticalScale(10),
  },
  flexButton: {
    flex: 1,
    marginTop: 0,
    marginLeft: horizontalScale(10),
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: getResponsiveFontSize(15),
    marginLeft: horizontalScale(8),
  },
  secondaryButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: moderateScale(12),
    paddingVertical: verticalScale(15),
  },
  secondaryButtonText: {
    fontWeight: '700',
    fontSize: getResponsiveFontSize(15),
    marginLeft: horizontalScale(8),
  },
});
