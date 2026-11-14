import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { horizontalScale, verticalScale, moderateScale, getResponsiveFontSize } from '../utils/responsive';
import {
  fetchLiveCapabilities,
  resolveLiveLink,
  fetchLiveAnalysis,
  fetchLiveManualAnalysis,
} from '../services/api';
import {
  VIEW_STATE,
  classifyResolveResult,
  classifyAnalysisResult,
  scoreLine,
  clockLine,
  manualBadge,
  manualBadgeDetail,
  withheldNotice,
  probabilityRows,
  projectionRows,
  factors,
  keyEvents,
  injuries,
  pregameContext,
  contextUpdatedLabel,
  tierLabel,
  hasContext,
  stalenessLabel,
  refreshSeconds,
  shouldPoll,
  candidateOptions,
} from '../utils/liveAnalysisView';

const SPORTS = [
  { key: 'soccer', label: 'Football' },
  { key: 'basketball', label: 'Basketball' },
];

/**
 * Live Game Analysis from a pasted link.
 *
 * Paste a bookmaker link to identify the game. Where the model has passed
 * backtesting the app shows a live probability; everywhere else it shows only
 * the score, the clock and context, and says why (the ship gate). Manual entry
 * is offered whenever nothing could be matched.
 */
export default function LiveAnalysisScreen({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const styles = createStyles(theme, isDarkMode);

  const [capabilities, setCapabilities] = useState(null);
  const [link, setLink] = useState('');
  const [resolveResult, setResolveResult] = useState(undefined); // undefined = idle
  const [analysis, setAnalysis] = useState(null);
  const [status, setStatus] = useState(VIEW_STATE.IDLE);
  const [message, setMessage] = useState(null);
  const [manualOpen, setManualOpen] = useState(false);

  const gameIdRef = useRef(null);
  const pollRef = useRef(null);

  // Capabilities tell us whether the surface is on at all, and carry the
  // disclaimer the server wants shown.
  useEffect(() => {
    let alive = true;
    fetchLiveCapabilities().then(caps => { if (alive) setCapabilities(caps); });
    return () => { alive = false; };
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const applyAnalysis = useCallback((next) => {
    const classified = classifyAnalysisResult(next);
    setStatus(classified.state);
    setMessage(classified.message);
    if (classified.state === VIEW_STATE.ANALYSIS) {
      setAnalysis(classified.analysis);
      gameIdRef.current = classified.analysis.game_id;
    }
    return classified;
  }, []);

  const startPolling = useCallback((seconds, gameId) => {
    stopPolling();
    if (!gameId) return;
    pollRef.current = setInterval(async () => {
      const next = await fetchLiveAnalysis(gameId);
      const classified = applyAnalysis(next);
      if (!shouldPoll(classified.analysis)) stopPolling();
    }, seconds * 1000);
  }, [applyAnalysis, stopPolling]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const handleResolve = async () => {
    const trimmed = link.trim();
    if (!trimmed) {
      setStatus(VIEW_STATE.ERROR);
      setMessage('Paste a bookmaker link first.');
      return;
    }
    stopPolling();
    setStatus(VIEW_STATE.LOADING);
    setMessage(null);
    setAnalysis(null);

    const result = await resolveLiveLink(trimmed);
    setResolveResult(result);
    const classified = classifyResolveResult(result);

    if (classified.state === VIEW_STATE.ANALYSIS) {
      applyAnalysis(classified.analysis);
      startPolling(refreshSeconds(classified.analysis), classified.analysis.game_id);
      return;
    }
    if (classified.state === VIEW_STATE.NONE) setManualOpen(true);
    setStatus(classified.state);
    setMessage(classified.message);
  };

  const handleSelectCandidate = async (gameId) => {
    stopPolling();
    setStatus(VIEW_STATE.LOADING);
    const next = await fetchLiveAnalysis(gameId);
    const classified = applyAnalysis(next);
    if (classified.state === VIEW_STATE.ANALYSIS) {
      startPolling(refreshSeconds(classified.analysis), gameId);
    }
  };

  const handleManualSubmit = async (input) => {
    stopPolling();
    setStatus(VIEW_STATE.LOADING);
    setAnalysis(null);
    const result = await fetchLiveManualAnalysis(input);
    const classified = applyAnalysis(result);
    setStatus(classified.state);
    setMessage(classified.message);
  };

  const disabled = capabilities && capabilities.unavailable === true;
  const featureOff = capabilities && capabilities.enabled === false;
  // Manual entry has its own switch: the form is hidden when it is off, without
  // hiding the rest of the live surface.
  const manualOff = capabilities && capabilities.manual_entry === false;
  const candidates = candidateOptions(resolveResult);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: theme.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Live Game Analysis</Text>
        <Text style={styles.subtitle}>
          Paste a bookmaker link to identify a game. The link is used to find the match only.
        </Text>

        {featureOff && (
          <View style={styles.notice}>
            <Text style={styles.noticeText}>Live game analysis is currently switched off.</Text>
          </View>
        )}

        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={link}
            onChangeText={setLink}
            placeholder="https://bookmaker.example/game/..."
            placeholderTextColor={theme.textSecondary}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!disabled && !featureOff}
            maxLength={2048}
          />
        </View>

        <TouchableOpacity
          style={[styles.primaryButton, (disabled || featureOff) && styles.buttonDisabled]}
          onPress={handleResolve}
          disabled={disabled || featureOff}
        >
          <Ionicons name="search" size={moderateScale(18)} color={theme.white} />
          <Text style={styles.primaryButtonText}>Analyse</Text>
        </TouchableOpacity>

        {status === VIEW_STATE.LOADING && (
          <ActivityIndicator style={styles.spinner} color={theme.primary} />
        )}

        {status === VIEW_STATE.ERROR && message && (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{message}</Text>
          </View>
        )}

        {status === VIEW_STATE.NONE && (
          <View style={styles.infoBox}>
            <Text style={styles.infoText}>{message}</Text>
            {manualOff ? (
              <Text style={styles.infoText}>Manual entry is currently switched off.</Text>
            ) : null}
          </View>
        )}

        {status === VIEW_STATE.CANDIDATES && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Which game did you mean?</Text>
            {message ? <Text style={styles.cardHint}>{message}</Text> : null}
            {candidates.map(option => (
              <TouchableOpacity
                key={option.gameId}
                style={styles.candidateRow}
                onPress={() => handleSelectCandidate(option.gameId)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.candidateLabel}>{option.label}</Text>
                  <Text style={styles.candidateMeta}>
                    {[option.league, option.score, option.clock].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={moderateScale(18)} color={theme.textSecondary} />
              </TouchableOpacity>
            ))}
          </View>
        )}

        {status === VIEW_STATE.ANALYSIS && analysis && (
          <AnalysisCard analysis={analysis} styles={styles} theme={theme} />
        )}

        {!manualOff && (
          <>
            <TouchableOpacity style={styles.toggle} onPress={() => setManualOpen(o => !o)}>
              <Ionicons
                name={manualOpen ? 'chevron-up' : 'chevron-down'}
                size={moderateScale(16)}
                color={theme.textSecondary}
              />
              <Text style={styles.toggleText}>
                {manualOpen ? 'Hide manual entry' : 'Enter the values manually'}
              </Text>
            </TouchableOpacity>

            {manualOpen && <ManualEntry styles={styles} theme={theme} onSubmit={handleManualSubmit} />}
          </>
        )}

        <Text style={styles.disclaimer}>
          {capabilities && capabilities.disclaimer
            ? capabilities.disclaimer
            : 'Live estimates are statistical model outputs, not betting advice.'}
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** The score/clock/context card, with model figures only when they are allowed. */
function AnalysisCard({ analysis, styles, theme }) {
  const probs = probabilityRows(analysis);
  const projections = projectionRows(analysis);
  const facts = factors(analysis);
  const withheld = withheldNotice(analysis);
  const age = stalenessLabel(analysis);
  const badge = manualBadge(analysis);
  const badgeDetail = manualBadgeDetail(analysis);
  const tier = tierLabel(analysis);
  const events = keyEvents(analysis);
  const injuryList = injuries(analysis);
  const pregame = pregameContext(analysis);
  const contextAge = contextUpdatedLabel(analysis);
  const context = hasContext(analysis);

  return (
    <View style={styles.card}>
      {/* The permanent badge for a hand-typed game. It is not conditional on
          the ship gate or on which figures render. */}
      {badge ? (
        <View style={styles.badge}>
          <Ionicons name="alert-circle" size={moderateScale(14)} color={theme.accent} />
          <Text style={styles.badgeText}>{badge}</Text>
        </View>
      ) : null}
      {badgeDetail ? <Text style={styles.badgeDetailText}>{badgeDetail}</Text> : null}

      <Text style={styles.leagueText}>
        {(analysis.league && analysis.league.name) || analysis.sport}
      </Text>
      <Text style={styles.scoreText}>{scoreLine(analysis)}</Text>
      <View style={styles.clockRow}>
        <Text style={styles.clockText}>{clockLine(analysis)}</Text>
        {age ? <Text style={styles.ageText}>{age}</Text> : null}
      </View>
      {/* Two provenance labels: which data tier this is, and how old the summary
          read behind the events/injuries is. */}
      <View style={styles.metaRow}>
        {tier ? <Text style={styles.tierText}>{tier}</Text> : null}
        {contextAge ? <Text style={styles.contextAgeText}>{contextAge}</Text> : null}
      </View>

      {probs.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Live probabilities</Text>
          {probs.map(row => (
            <View key={row.key} style={styles.row}>
              <Text style={styles.rowLabel}>{row.label}</Text>
              <Text style={styles.rowValue}>{row.display}</Text>
            </View>
          ))}
          {projections.map(row => (
            <View key={row.label} style={styles.row}>
              <Text style={styles.rowLabel}>{row.label}</Text>
              <Text style={styles.rowValue}>{row.display}</Text>
            </View>
          ))}
        </View>
      ) : (
        <View style={styles.withheldBox}>
          <Text style={styles.withheldTitle}>Score and context only</Text>
          <Text style={styles.withheldText}>{withheld}</Text>
        </View>
      )}

      {events.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Key events</Text>
          {events.map((ev, i) => (
            <View key={`ev-${i}`} style={styles.eventRow}>
              <View style={styles.eventMarker}>
                <Text style={styles.eventWhen}>{ev.when || '—'}</Text>
                <View style={[styles.eventDot, ev.scoring && styles.eventDotScoring]} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.eventWhat}>
                  {ev.what}{ev.team ? ` · ${ev.team}` : ''}
                </Text>
                {ev.detail ? <Text style={styles.eventDetail}>{ev.detail}</Text> : null}
              </View>
            </View>
          ))}
        </View>
      )}

      {injuryList.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Injuries</Text>
          {injuryList.map((inj, i) => (
            <View key={`inj-${i}`} style={styles.injuryRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.injuryWho}>
                  {inj.who}{inj.position ? ` · ${inj.position}` : ''}
                </Text>
                {inj.team ? <Text style={styles.injuryTeam}>{inj.team}</Text> : null}
              </View>
              {inj.status ? <Text style={styles.injuryStatus}>{inj.status}</Text> : null}
            </View>
          ))}
        </View>
      )}

      {pregame && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Match setting</Text>
          {pregame.lines.map((line, i) => (
            <View key={`pg-${i}`} style={styles.row}>
              <Text style={styles.rowLabel}>{line.label}</Text>
              <Text style={styles.rowValue}>{line.value}</Text>
            </View>
          ))}
        </View>
      )}

      {facts.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Context</Text>
          {facts.map((f, i) => (
            <View key={`${f.label}-${i}`} style={styles.factorRow}>
              <Text style={styles.factorLabel}>{f.label}</Text>
              <Text style={styles.factorDetail}>{f.detail}</Text>
            </View>
          ))}
        </View>
      )}

      {!context && (
        <Text style={styles.emptyContextText}>
          Lineups, key events and injuries appear here once the provider publishes them.
        </Text>
      )}
    </View>
  );
}

/** The fallback path: type the numbers, get a labelled context-only analysis. */
function ManualEntry({ styles, theme, onSubmit }) {
  const [sport, setSport] = useState('soccer');
  const [form, setForm] = useState({
    home_name: '', away_name: '', home_score: '', away_score: '', clock: '', period: '',
  });

  const set = (key) => (value) => setForm(prev => ({ ...prev, [key]: value }));

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Manual entry</Text>
      <Text style={styles.cardHint}>
        These values are not checked against a provider. The result carries a permanent
        {' '}&ldquo;User-entered, unverified&rdquo; badge and is excluded from our accuracy statistics.
      </Text>

      <View style={styles.sportRow}>
        {SPORTS.map(s => (
          <TouchableOpacity
            key={s.key}
            style={[styles.sportChip, sport === s.key && styles.sportChipActive]}
            onPress={() => setSport(s.key)}
          >
            <Text style={[styles.sportChipText, sport === s.key && styles.sportChipTextActive]}>
              {s.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ManualField styles={styles} theme={theme} label="Home team" value={form.home_name} onChangeText={set('home_name')} placeholder="Arsenal" />
      <ManualField styles={styles} theme={theme} label="Away team" value={form.away_name} onChangeText={set('away_name')} placeholder="Liverpool" />
      <ManualField styles={styles} theme={theme} label="Home score" value={form.home_score} onChangeText={set('home_score')} keyboardType="number-pad" placeholder="1" />
      <ManualField styles={styles} theme={theme} label="Away score" value={form.away_score} onChangeText={set('away_score')} keyboardType="number-pad" placeholder="0" />
      <ManualField styles={styles} theme={theme} label="Clock" value={form.clock} onChangeText={set('clock')} placeholder="60'  or  7:24" />
      <ManualField styles={styles} theme={theme} label="Period" value={form.period} onChangeText={set('period')} keyboardType="number-pad" placeholder="2" />

      <TouchableOpacity
        style={styles.primaryButton}
        onPress={() => onSubmit({
          sport,
          home_name: form.home_name,
          away_name: form.away_name,
          home_score: form.home_score === '' ? null : Number(form.home_score),
          away_score: form.away_score === '' ? null : Number(form.away_score),
          clock: form.clock || null,
          period: form.period === '' ? null : Number(form.period),
          status: 'live',
        })}
      >
        <Ionicons name="stats-chart" size={moderateScale(18)} color={theme.white} />
        <Text style={styles.primaryButtonText}>Analyse manually</Text>
      </TouchableOpacity>
    </View>
  );
}

function ManualField({ styles, theme, label, ...props }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={styles.fieldInput}
        placeholderTextColor={theme.textSecondary}
        autoCapitalize="words"
        {...props}
      />
    </View>
  );
}

const createStyles = (theme) => StyleSheet.create({
  content: {
    padding: horizontalScale(16),
    paddingBottom: verticalScale(40),
  },
  title: {
    color: theme.text,
    fontSize: getResponsiveFontSize(24),
    fontWeight: '700',
    marginTop: verticalScale(8),
  },
  subtitle: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(13),
    marginTop: verticalScale(6),
    marginBottom: verticalScale(16),
  },
  inputRow: { marginBottom: verticalScale(12) },
  input: {
    backgroundColor: theme.cardBg,
    borderRadius: moderateScale(10),
    borderWidth: 1,
    borderColor: theme.border,
    paddingHorizontal: horizontalScale(14),
    paddingVertical: verticalScale(12),
    color: theme.text,
    fontSize: getResponsiveFontSize(14),
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: horizontalScale(8),
    backgroundColor: theme.primary,
    borderRadius: moderateScale(10),
    paddingVertical: verticalScale(13),
    minHeight: 48,
  },
  buttonDisabled: { opacity: 0.5 },
  primaryButtonText: {
    color: theme.white,
    fontWeight: '700',
    fontSize: getResponsiveFontSize(15),
  },
  spinner: { marginTop: verticalScale(20) },
  errorBox: {
    marginTop: verticalScale(14),
    padding: horizontalScale(14),
    borderRadius: moderateScale(10),
    borderWidth: 1,
    borderColor: theme.error,
  },
  errorText: { color: theme.error, fontSize: getResponsiveFontSize(13) },
  infoBox: {
    marginTop: verticalScale(14),
    padding: horizontalScale(14),
    borderRadius: moderateScale(10),
    backgroundColor: theme.cardBg,
  },
  infoText: { color: theme.textSecondary, fontSize: getResponsiveFontSize(13) },
  notice: {
    backgroundColor: theme.cardBg,
    borderRadius: moderateScale(10),
    padding: horizontalScale(14),
    marginBottom: verticalScale(12),
  },
  noticeText: { color: theme.text, fontSize: getResponsiveFontSize(13) },
  card: {
    marginTop: verticalScale(16),
    backgroundColor: theme.cardBg,
    borderRadius: moderateScale(14),
    padding: horizontalScale(16),
    borderWidth: 1,
    borderColor: theme.border,
  },
  cardTitle: {
    color: theme.text,
    fontSize: getResponsiveFontSize(16),
    fontWeight: '700',
    marginBottom: verticalScale(6),
  },
  cardHint: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(12),
    marginBottom: verticalScale(10),
  },
  candidateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: verticalScale(12),
    borderTopWidth: 1,
    borderTopColor: theme.border,
    minHeight: 48,
  },
  candidateLabel: { color: theme.text, fontSize: getResponsiveFontSize(14), fontWeight: '600' },
  candidateMeta: { color: theme.textSecondary, fontSize: getResponsiveFontSize(12), marginTop: 2 },
  leagueText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(12),
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: horizontalScale(5),
    paddingHorizontal: horizontalScale(9),
    paddingVertical: verticalScale(4),
    borderRadius: moderateScale(6),
    borderWidth: 1,
    borderColor: theme.accent,
    marginBottom: verticalScale(8),
  },
  badgeText: { color: theme.accent, fontSize: getResponsiveFontSize(11), fontWeight: '700' },
  badgeDetailText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(11),
    lineHeight: getResponsiveFontSize(15),
    marginBottom: verticalScale(8),
  },
  scoreText: {
    color: theme.text,
    fontSize: getResponsiveFontSize(34),
    fontWeight: '800',
    marginVertical: verticalScale(6),
  },
  clockRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  clockText: { color: theme.primary, fontSize: getResponsiveFontSize(14), fontWeight: '600' },
  ageText: { color: theme.textSecondary, fontSize: getResponsiveFontSize(11) },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: verticalScale(4),
  },
  tierText: { color: theme.textSecondary, fontSize: getResponsiveFontSize(11) },
  contextAgeText: { color: theme.textSecondary, fontSize: getResponsiveFontSize(11) },
  section: { marginTop: verticalScale(16) },
  sectionTitle: {
    color: theme.text,
    fontSize: getResponsiveFontSize(14),
    fontWeight: '700',
    marginBottom: verticalScale(8),
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: verticalScale(6),
  },
  rowLabel: { color: theme.textSecondary, fontSize: getResponsiveFontSize(13) },
  rowValue: { color: theme.text, fontSize: getResponsiveFontSize(13), fontWeight: '700' },
  withheldBox: {
    marginTop: verticalScale(16),
    padding: horizontalScale(14),
    borderRadius: moderateScale(10),
    backgroundColor: theme.bg,
    borderWidth: 1,
    borderColor: theme.border,
  },
  withheldTitle: { color: theme.text, fontWeight: '700', fontSize: getResponsiveFontSize(14) },
  withheldText: { color: theme.textSecondary, fontSize: getResponsiveFontSize(12), marginTop: verticalScale(4) },
  factorRow: { marginBottom: verticalScale(8) },
  factorLabel: { color: theme.accent, fontSize: getResponsiveFontSize(12), fontWeight: '600' },
  factorDetail: { color: theme.textSecondary, fontSize: getResponsiveFontSize(12), marginTop: 2 },
  eventRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: horizontalScale(10),
    paddingVertical: verticalScale(6),
    borderTopWidth: 1,
    borderTopColor: theme.border,
  },
  eventMarker: { alignItems: 'center', minWidth: horizontalScale(58) },
  eventWhen: {
    color: theme.primary,
    fontSize: getResponsiveFontSize(12),
    fontWeight: '700',
  },
  eventDot: {
    width: moderateScale(7),
    height: moderateScale(7),
    borderRadius: moderateScale(4),
    marginTop: verticalScale(4),
    backgroundColor: theme.textSecondary,
  },
  eventDotScoring: { backgroundColor: theme.accent },
  eventWhat: { color: theme.text, fontSize: getResponsiveFontSize(13), fontWeight: '600' },
  eventDetail: { color: theme.textSecondary, fontSize: getResponsiveFontSize(12), marginTop: 2 },
  injuryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: horizontalScale(10),
    paddingVertical: verticalScale(6),
    borderTopWidth: 1,
    borderTopColor: theme.border,
  },
  injuryWho: { color: theme.text, fontSize: getResponsiveFontSize(13), fontWeight: '600' },
  injuryTeam: { color: theme.textSecondary, fontSize: getResponsiveFontSize(11), marginTop: 2 },
  injuryStatus: {
    color: theme.accent,
    fontSize: getResponsiveFontSize(11),
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  emptyContextText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(11),
    marginTop: verticalScale(12),
    lineHeight: getResponsiveFontSize(16),
  },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: horizontalScale(6),
    marginTop: verticalScale(20),
    minHeight: 48,
  },
  toggleText: { color: theme.textSecondary, fontSize: getResponsiveFontSize(13), fontWeight: '600' },
  sportRow: { flexDirection: 'row', gap: horizontalScale(8), marginBottom: verticalScale(12) },
  sportChip: {
    paddingHorizontal: horizontalScale(14),
    paddingVertical: verticalScale(8),
    borderRadius: moderateScale(20),
    borderWidth: 1,
    borderColor: theme.border,
    minHeight: 40,
    justifyContent: 'center',
  },
  sportChipActive: { backgroundColor: theme.primary, borderColor: theme.primary },
  sportChipText: { color: theme.textSecondary, fontSize: getResponsiveFontSize(13) },
  sportChipTextActive: { color: theme.white, fontWeight: '700' },
  field: { marginBottom: verticalScale(10) },
  fieldLabel: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(12),
    marginBottom: verticalScale(4),
  },
  fieldInput: {
    backgroundColor: theme.bg,
    borderRadius: moderateScale(8),
    borderWidth: 1,
    borderColor: theme.border,
    paddingHorizontal: horizontalScale(12),
    paddingVertical: verticalScale(10),
    color: theme.text,
    fontSize: getResponsiveFontSize(14),
  },
  disclaimer: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(11),
    marginTop: verticalScale(28),
    lineHeight: getResponsiveFontSize(16),
  },
});
