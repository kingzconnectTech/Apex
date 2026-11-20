import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  ActivityIndicator, FlatList, Modal, RefreshControl, StatusBar, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import * as Clipboard from 'expo-clipboard';
import { useTheme } from '../context/ThemeContext';
import { horizontalScale, verticalScale, moderateScale, getResponsiveFontSize } from '../utils/responsive';
import { fetchLiveCapabilities, fetchLiveMatches, validateSiteLink } from '../services/api';
import {
  VIEW_STATE,
  classifyMatchesResult,
  refreshSeconds,
  updatedLabel,
  siteOptions,
  sourceSummary,
  classifyValidation,
  validateInput,
} from '../utils/liveMatchesView';

/**
 * Live Matches — the games in play right now, read from two public score sites.
 *
 * The server lists the in-play games (FlashScore / LiveScore); this screen
 * renders them, auto-refreshes the status, and opens any match — or the user's
 * own preferred link — in an in-app browser. A pasted link is validated before
 * it opens, so a non-http(s) URL never reaches the WebView.
 */
export default function LiveMatchesScreen() {
  const { theme } = useTheme();
  const styles = useMemo(() => createStyles(theme), [theme]);

  const [capabilities, setCapabilities] = useState(null);
  const [payload, setPayload] = useState(null);
  const [view, setView] = useState({ state: VIEW_STATE.LOADING, message: null, matches: [] });
  const [refreshing, setRefreshing] = useState(false);

  const [customLink, setCustomLink] = useState('');
  const [customState, setCustomState] = useState('idle'); // idle | checking | ok | error
  const [customMessage, setCustomMessage] = useState(null);

  const [browser, setBrowser] = useState(null); // { url, title }
  const [now, setNow] = useState(Date.now());

  const pollRef = useRef(null);
  const mountedRef = useRef(true);

  // Capabilities carry the site list, the master switch and the disclaimer.
  useEffect(() => {
    let alive = true;
    fetchLiveCapabilities().then(caps => { if (alive) setCapabilities(caps); });
    return () => { alive = false; };
  }, []);

  const load = useCallback(async ({ force = false, pull = false } = {}) => {
    if (pull) setRefreshing(true);
    const result = await fetchLiveMatches({ force });
    if (!mountedRef.current) return;
    setPayload(result);
    setView(classifyMatchesResult(result));
    if (pull) setRefreshing(false);
  }, []);

  // First load.
  useEffect(() => {
    mountedRef.current = true;
    load();
    return () => { mountedRef.current = false; };
  }, [load]);

  // Auto-refresh at the server-suggested cadence; a fresh read bypasses the
  // short server cache so the score/clock the user sees is actually current.
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    const seconds = refreshSeconds(payload);
    pollRef.current = setInterval(() => load({ force: true }), seconds * 1000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [payload, load]);

  // A 1s tick keeps the "updated Ns ago" label honest without re-fetching.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const featureOff = capabilities && capabilities.matches && capabilities.matches.enabled === false;
  const sites = siteOptions(capabilities, payload);
  const sources = sourceSummary(payload);

  const openBrowser = useCallback((url, title = null) => {
    if (!url) return;
    setBrowser({ url, title });
  }, []);

  const handleOpenSite = (site) => {
    if (site && site.home) openBrowser(site.home, site.name);
  };

  const handleOpenCustom = async () => {
    const pre = validateInput(customLink);
    if (!pre.ok) {
      setCustomState('error');
      setCustomMessage(pre.message);
      return;
    }
    setCustomState('checking');
    setCustomMessage(null);
    const verdict = await validateSiteLink(pre.value);
    const classified = classifyValidation(verdict);
    if (!classified.ok) {
      setCustomState('error');
      setCustomMessage(classified.message);
      return;
    }
    setCustomState('ok');
    setCustomMessage(
      classified.note
        ? classified.note
        : (classified.siteName ? `Opening ${classified.siteName}…` : null),
    );
    openBrowser(classified.url);
  };

  const updated = updatedLabel(payload, now);

  const header = (
    <View>
      <Text style={styles.title}>Live Matches</Text>
      <Text style={styles.subtitle}>
        Games in play now, read from FlashScore and LiveScore. Open any match in the
        in-app browser, copy a match link, or add your own link below.
      </Text>

      {featureOff ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>The live matches feed is currently switched off.</Text>
        </View>
      ) : null}

      {/* Preferred sites — the allow-list of known score sites. */}
      <Text style={styles.sectionHeading}>Open a site</Text>
      <View style={styles.chipRow}>
        {sites.map(site => (
          <TouchableOpacity
            key={site.id}
            style={styles.siteChip}
            onPress={() => handleOpenSite(site)}
            disabled={!site.home}
          >
            <Ionicons name="globe-outline" size={moderateScale(15)} color={theme.text} />
            <Text style={styles.siteChipText}>{site.name}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* The user's own link — validated before it can open. */}
      <Text style={styles.sectionHeading}>Or paste your own link</Text>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={customLink}
          onChangeText={(v) => { setCustomLink(v); if (customState !== 'idle') { setCustomState('idle'); setCustomMessage(null); } }}
          placeholder="https://example.com/live/..."
          placeholderTextColor={theme.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          editable={!featureOff}
          maxLength={2048}
          returnKeyType="go"
          onSubmitEditing={handleOpenCustom}
        />
        <TouchableOpacity
          style={[styles.openButton, featureOff && styles.buttonDisabled]}
          onPress={handleOpenCustom}
          disabled={featureOff || customState === 'checking'}
        >
          {customState === 'checking'
            ? <ActivityIndicator color={theme.white} />
            : <Ionicons name="open-outline" size={moderateScale(18)} color={theme.white} />}
        </TouchableOpacity>
      </View>
      {customMessage ? (
        <View style={[styles.inlineBox, customState === 'error' ? styles.inlineError : styles.inlineInfo]}>
          <Ionicons
            name={customState === 'error' ? 'alert-circle-outline' : 'information-circle-outline'}
            size={moderateScale(15)}
            color={customState === 'error' ? theme.error : theme.textSecondary}
          />
          <Text style={[styles.inlineText, customState === 'error' && styles.inlineErrorText]}>
            {customMessage}
          </Text>
        </View>
      ) : null}

      {/* Live list controls. */}
      <View style={styles.listControls}>
        <Text style={styles.sectionHeading}>
          In play now{view.state === VIEW_STATE.READY ? ` · ${view.matches.length}` : ''}
        </Text>
        <View style={styles.listControlsRight}>
          {updated ? <Text style={styles.updated}>{updated}</Text> : null}
          <TouchableOpacity
            style={styles.refreshButton}
            onPress={() => load({ force: true, pull: true })}
            disabled={featureOff}
            accessibilityLabel="Refresh live matches"
          >
            <Ionicons name="refresh" size={moderateScale(18)} color={theme.primary} />
          </TouchableOpacity>
        </View>
      </View>

      {sources.length > 0 ? (
        <View style={styles.sourceRow}>
          {sources.map(s => (
            <Text
              key={s.id}
              style={[styles.sourceText, !s.ok && styles.sourceTextFailed]}
            >
              {s.ok ? `${s.name} · ${s.count}` : `${s.name} · unreachable`}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );

  const empty = () => {
    if (view.state === VIEW_STATE.LOADING) {
      return <ActivityIndicator style={styles.spinner} color={theme.primary} />;
    }
    if (view.state === VIEW_STATE.ERROR) {
      return (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{view.message}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => load({ force: true, pull: true })}>
            <Text style={styles.retryButtonText}>Try again</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <View style={styles.infoBox}>
        <Text style={styles.infoText}>{view.message}</Text>
      </View>
    );
  };

  return (
    <View style={styles.screen}>
      <FlatList
        data={view.state === VIEW_STATE.READY ? view.matches : []}
        keyExtractor={(item) => item.id || `${item.homeName}-${item.awayName}`}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        renderItem={({ item }) => (
          <MatchCard match={item} styles={styles} theme={theme} onOpen={openBrowser} />
        )}
        contentContainerStyle={styles.content}
        refreshControl={(
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load({ force: true, pull: true })}
            tintColor={theme.primary}
            colors={[theme.primary]}
          />
        )}
        ListFooterComponent={(
          <Text style={styles.disclaimer}>
            {capabilities && capabilities.disclaimer
              ? capabilities.disclaimer
              : 'Live estimates are statistical model outputs, not betting advice.'}
          </Text>
        )}
      />

      <BrowserModal
        browser={browser}
        styles={styles}
        theme={theme}
        onClose={() => setBrowser(null)}
      />
    </View>
  );
}

/** One in-play match: league, teams, score, live phase, and its site links. */
function MatchCard({ match, styles, theme, onOpen }) {
  const primary = match.url || (match.links[0] && match.links[0].url) || null;
  // Which link chip was last copied, so its button can say "Copied" for a beat.
  const [copiedKey, setCopiedKey] = useState(null);
  const copyTimer = useRef(null);

  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  const copyLink = async (url, key) => {
    if (!url) return;
    await Clipboard.setStringAsync(url);
    setCopiedKey(key);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopiedKey(null), 1500);
  };

  return (
    <TouchableOpacity
      style={styles.card}
      activeOpacity={primary ? 0.8 : 1}
      onPress={() => primary && onOpen(primary, `${match.homeName} vs ${match.awayName}`)}
      disabled={!primary}
    >
      <View style={styles.cardTopRow}>
        <Text style={styles.leagueText} numberOfLines={1}>
          {[match.country, match.league].filter(Boolean).join(' · ') || match.sportLabel || 'Live'}
        </Text>
        <View style={styles.liveRight}>
          {match.timeLabel ? (
            <Text style={styles.timeText}>{match.timeLabel}</Text>
          ) : null}
          <View style={styles.liveBadge}>
            <View style={styles.liveDot} />
            <Text style={styles.liveBadgeText}>{match.statusLabel}</Text>
          </View>
        </View>
      </View>

      <View style={styles.teamsRow}>
        <View style={styles.teamCol}>
          <Text style={styles.teamName} numberOfLines={1}>{match.homeName}</Text>
          <Text style={styles.teamName} numberOfLines={1}>{match.awayName}</Text>
        </View>
        <View style={styles.scoreCol}>
          <Text style={styles.scoreValue} numberOfLines={1}>{match.homeScore == null ? '-' : match.homeScore}</Text>
          <Text style={styles.scoreValue} numberOfLines={1}>{match.awayScore == null ? '-' : match.awayScore}</Text>
        </View>
      </View>

      {match.links.length > 0 ? (
        <View style={styles.linkChipRow}>
          {match.links.map((link, i) => {
            if (!link.url) return null;
            const key = `${match.id}-${link.source}-${i}`;
            const copied = copiedKey === key;
            return (
              <View key={key} style={styles.linkChip}>
                <TouchableOpacity
                  style={styles.linkOpen}
                  onPress={() => onOpen(link.url, link.sourceName)}
                  accessibilityLabel={`Open ${link.sourceName || 'match'} link`}
                >
                  <Ionicons name="open-outline" size={moderateScale(13)} color={theme.primary} />
                  <Text style={styles.linkChipText}>{link.sourceName || 'Open'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.linkCopy}
                  onPress={() => copyLink(link.url, key)}
                  accessibilityLabel={`Copy ${link.sourceName || 'match'} link`}
                >
                  <Ionicons
                    name={copied ? 'checkmark' : 'copy-outline'}
                    size={moderateScale(13)}
                    color={copied ? theme.success : theme.textSecondary}
                  />
                </TouchableOpacity>
              </View>
            );
          })}
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

/** The in-app browser: a modal WebView restricted to http(s). */
function BrowserModal({ browser, styles, theme, onClose }) {
  const webRef = useRef(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [failed, setFailed] = useState(null);

  useEffect(() => { setCanGoBack(false); setFailed(null); }, [browser && browser.url]);

  if (!browser) return null;

  // Only http(s) may load. A link is already validated server-side; this also
  // stops an in-page navigation to `intent://`, `mailto:` or `javascript:`.
  const allow = (url) => url === 'about:blank' || /^https?:\/\//i.test(String(url || ''));

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.browserScreen}>
        <View style={styles.browserBar}>
          <TouchableOpacity style={styles.browserIconButton} onPress={onClose} accessibilityLabel="Close browser">
            <Ionicons name="close" size={moderateScale(22)} color={theme.text} />
          </TouchableOpacity>
          <View style={styles.browserAddress}>
            <Text style={styles.browserTitle} numberOfLines={1}>
              {browser.title || browser.url}
            </Text>
            <Text style={styles.browserUrl} numberOfLines={1}>{browser.url}</Text>
          </View>
          <TouchableOpacity
            style={styles.browserIconButton}
            onPress={() => { setFailed(null); webRef.current && webRef.current.reload(); }}
            accessibilityLabel="Reload"
          >
            <Ionicons name="refresh" size={moderateScale(20)} color={theme.text} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.browserIconButton, !canGoBack && styles.browserIconDisabled]}
            onPress={() => { webRef.current && webRef.current.goBack(); }}
            disabled={!canGoBack}
            accessibilityLabel="Back"
          >
            <Ionicons name="chevron-back" size={moderateScale(20)} color={theme.text} />
          </TouchableOpacity>
        </View>

        {failed ? (
          <View style={styles.browserError}>
            <Ionicons name="cloud-offline-outline" size={moderateScale(34)} color={theme.textSecondary} />
            <Text style={styles.browserErrorText}>{failed}</Text>
            <TouchableOpacity
              style={styles.retryButton}
              onPress={() => { setFailed(null); webRef.current && webRef.current.reload(); }}
            >
              <Text style={styles.retryButtonText}>Try again</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <WebView
            ref={webRef}
            source={{ uri: browser.url }}
            startInLoadingState
            renderLoading={() => <ActivityIndicator style={styles.spinner} color={theme.primary} />}
            onShouldStartLoadWithRequest={(req) => allow(req.url)}
            onNavigationStateChange={(nav) => setCanGoBack(Boolean(nav.canGoBack))}
            onError={({ nativeEvent }) => setFailed(nativeEvent && nativeEvent.description
              ? nativeEvent.description
              : 'This page could not be loaded.')}
            onHttpError={({ nativeEvent }) => setFailed(
              nativeEvent && nativeEvent.statusCode
                ? `The site returned ${nativeEvent.statusCode}.`
                : 'This page could not be loaded.',
            )}
            style={styles.webview}
          />
        )}
      </View>
    </Modal>
  );
}

const createStyles = (theme) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
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
    lineHeight: getResponsiveFontSize(18),
  },
  notice: {
    backgroundColor: theme.cardBg,
    borderRadius: moderateScale(10),
    padding: horizontalScale(14),
    marginBottom: verticalScale(12),
  },
  noticeText: { color: theme.text, fontSize: getResponsiveFontSize(13) },
  sectionHeading: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(12),
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: verticalScale(8),
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: horizontalScale(8),
    marginBottom: verticalScale(18),
  },
  siteChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: horizontalScale(6),
    paddingHorizontal: horizontalScale(14),
    paddingVertical: verticalScale(10),
    borderRadius: moderateScale(22),
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.cardBg,
    minHeight: 44,
  },
  siteChipText: { color: theme.text, fontSize: getResponsiveFontSize(13), fontWeight: '600' },
  inputRow: { flexDirection: 'row', gap: horizontalScale(8), marginBottom: verticalScale(8) },
  input: {
    flex: 1,
    backgroundColor: theme.cardBg,
    borderRadius: moderateScale(10),
    borderWidth: 1,
    borderColor: theme.border,
    paddingHorizontal: horizontalScale(14),
    paddingVertical: verticalScale(12),
    color: theme.text,
    fontSize: getResponsiveFontSize(14),
    minHeight: 48,
  },
  openButton: {
    width: 48,
    height: 48,
    borderRadius: moderateScale(10),
    backgroundColor: theme.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonDisabled: { opacity: 0.5 },
  inlineBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: horizontalScale(6),
    padding: horizontalScale(10),
    borderRadius: moderateScale(8),
    marginBottom: verticalScale(8),
  },
  inlineInfo: { backgroundColor: theme.cardBg },
  inlineError: { borderWidth: 1, borderColor: theme.error },
  inlineText: { flex: 1, color: theme.textSecondary, fontSize: getResponsiveFontSize(12), lineHeight: getResponsiveFontSize(17) },
  inlineErrorText: { color: theme.error },
  listControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: verticalScale(10),
  },
  listControlsRight: { flexDirection: 'row', alignItems: 'center', gap: horizontalScale(10) },
  updated: { color: theme.textSecondary, fontSize: getResponsiveFontSize(11) },
  refreshButton: {
    width: 44,
    height: 44,
    borderRadius: moderateScale(22),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.cardBg,
  },
  sourceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: horizontalScale(12), marginBottom: verticalScale(4) },
  sourceText: { color: theme.textSecondary, fontSize: getResponsiveFontSize(11) },
  sourceTextFailed: { color: theme.warning },
  card: {
    marginTop: verticalScale(12),
    backgroundColor: theme.cardBg,
    borderRadius: moderateScale(14),
    padding: horizontalScale(14),
    borderWidth: 1,
    borderColor: theme.border,
  },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: horizontalScale(10),
  },
  leagueText: {
    flex: 1,
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(11),
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: horizontalScale(5),
    paddingHorizontal: horizontalScale(8),
    paddingVertical: verticalScale(3),
    borderRadius: moderateScale(6),
    borderWidth: 1,
    borderColor: theme.success,
  },
  liveDot: { width: moderateScale(6), height: moderateScale(6), borderRadius: moderateScale(3), backgroundColor: theme.success },
  liveBadgeText: { color: theme.success, fontSize: getResponsiveFontSize(10), fontWeight: '700' },
  liveRight: { flexDirection: 'row', alignItems: 'center', gap: horizontalScale(8) },
  timeText: {
    color: theme.text,
    fontSize: getResponsiveFontSize(12),
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  teamsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: verticalScale(10),
    gap: horizontalScale(10),
  },
  teamCol: { flex: 1 },
  teamName: {
    color: theme.text,
    fontSize: getResponsiveFontSize(15),
    fontWeight: '600',
    marginVertical: verticalScale(2),
  },
  scoreCol: { alignItems: 'flex-end' },
  scoreValue: {
    color: theme.text,
    fontSize: getResponsiveFontSize(18),
    fontWeight: '800',
    marginVertical: verticalScale(2),
  },
  linkChipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: horizontalScale(8), marginTop: verticalScale(10) },
  linkChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: moderateScale(22),
    borderWidth: 1,
    borderColor: theme.border,
    overflow: 'hidden',
    minHeight: 44,
  },
  linkOpen: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: horizontalScale(4),
    paddingLeft: horizontalScale(12),
    paddingRight: horizontalScale(8),
    paddingVertical: verticalScale(8),
    minHeight: 44,
  },
  linkCopy: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: horizontalScale(10),
    paddingVertical: verticalScale(8),
    minHeight: 44,
    minWidth: 44,
    borderLeftWidth: 1,
    borderLeftColor: theme.border,
  },
  linkChipText: { color: theme.primary, fontSize: getResponsiveFontSize(12), fontWeight: '600' },
  spinner: { marginTop: verticalScale(24) },
  errorBox: {
    marginTop: verticalScale(16),
    padding: horizontalScale(14),
    borderRadius: moderateScale(10),
    borderWidth: 1,
    borderColor: theme.error,
  },
  errorText: { color: theme.error, fontSize: getResponsiveFontSize(13) },
  infoBox: {
    marginTop: verticalScale(16),
    padding: horizontalScale(14),
    borderRadius: moderateScale(10),
    backgroundColor: theme.cardBg,
  },
  infoText: { color: theme.textSecondary, fontSize: getResponsiveFontSize(13) },
  retryButton: {
    marginTop: verticalScale(12),
    alignSelf: 'flex-start',
    paddingHorizontal: horizontalScale(16),
    paddingVertical: verticalScale(10),
    borderRadius: moderateScale(8),
    borderWidth: 1,
    borderColor: theme.primary,
    minHeight: 44,
    justifyContent: 'center',
  },
  retryButtonText: { color: theme.primary, fontSize: getResponsiveFontSize(13), fontWeight: '700' },
  disclaimer: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(11),
    marginTop: verticalScale(28),
    lineHeight: getResponsiveFontSize(16),
  },
  browserScreen: { flex: 1, backgroundColor: theme.bg },
  browserBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: horizontalScale(6),
    paddingHorizontal: horizontalScale(8),
    paddingTop: Platform.OS === 'android' ? (StatusBar.currentHeight || 0) + verticalScale(6) : verticalScale(46),
    paddingBottom: verticalScale(8),
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
    backgroundColor: theme.bg,
  },
  browserIconButton: {
    width: 44,
    height: 44,
    borderRadius: moderateScale(22),
    alignItems: 'center',
    justifyContent: 'center',
  },
  browserIconDisabled: { opacity: 0.35 },
  browserAddress: { flex: 1, justifyContent: 'center' },
  browserTitle: { color: theme.text, fontSize: getResponsiveFontSize(13), fontWeight: '700' },
  browserUrl: { color: theme.textSecondary, fontSize: getResponsiveFontSize(11), marginTop: 1 },
  webview: { flex: 1, backgroundColor: theme.bg },
  browserError: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: horizontalScale(24),
    gap: verticalScale(10),
  },
  browserErrorText: {
    color: theme.textSecondary,
    fontSize: getResponsiveFontSize(13),
    textAlign: 'center',
    lineHeight: getResponsiveFontSize(19),
  },
});
