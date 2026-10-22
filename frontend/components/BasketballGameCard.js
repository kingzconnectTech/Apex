import React, { useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { moderateScale, getResponsiveFontSize, verticalScale } from '../utils/responsive';
import ProbabilityBar from './ProbabilityBar';
import ConfidenceBadge from './ConfidenceBadge';
import ValueTag from './ValueTag';
import LineMovedIndicator from './LineMovedIndicator';
import WhyThisPick from './WhyThisPick';
import { resolveMarketViews } from '../utils/basketballPredictionView';

const MARKET_COLORS = {
  'Total Points': '#00F2FE',
  Spread: '#FF6B6B',
};

/** Resolve real team identity, falling back to the "A vs B" label only. */
function resolveTeams(prediction) {
  const [labelHome, labelAway] = String(prediction.game || '').split(' vs ');
  const home = prediction.homeTeam || {};
  const away = prediction.awayTeam || {};
  return {
    homeName: home.name || labelHome || 'Home',
    awayName: away.name || labelAway || 'Away',
    homeLogo: home.logo || null,
    awayLogo: away.logo || null,
  };
}

function formatTipoff(iso) {
  if (!iso) return 'TBD';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'TBD';
  return d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * One basketball game card: projected score, both market picks (or an explicit
 * "no confident pick"), probability bars, confidence + value badges, an optional
 * line-moved indicator and an expandable "Why this pick" panel.
 *
 * Every value comes from the API payload — nothing is hardcoded.
 */
export default function BasketballGameCard({ prediction, onPress }) {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  // Detect line movement across refreshes within this card's lifetime.
  const seenLines = useRef({});
  const movements = {};
  (prediction.picks || []).forEach(p => {
    const key = `${p.market}|${p.selection}`;
    const prev = seenLines.current[key];
    if (prev != null && p.line != null && Math.abs(prev - p.line) >= 0.5) {
      movements[key] = { moved: true, from: prev, to: p.line, delta: Number((p.line - prev).toFixed(2)) };
    }
    if (p.line != null) seenLines.current[key] = p.line;
  });

  const { homeName, awayName, homeLogo, awayLogo } = resolveTeams(prediction);
  const score = prediction.score || {};
  const projection = prediction.projection || {};
  const riskFlags = Array.isArray(prediction.risk_flags) ? prediction.risk_flags : [];
  const dq = Number(prediction.data_quality);

  const handlePress = () => {
    if (!onPress) return;
    onPress({
      id: prediction.gameId,
      league: prediction.league,
      sport: 'basketball',
      date: prediction.tipoff,
      time: formatTipoff(prediction.tipoff),
      status: 'pre',
      homeTeam: { name: homeName, logo: homeLogo },
      awayTeam: { name: awayName, logo: awayLogo },
      basketballPrediction: prediction,
    });
  };

  const renderPick = ({ market, pick, emptyLabel }) => {
    const color = MARKET_COLORS[market] || theme.primary;

    if (!pick) {
      return (
        <View key={market} style={styles.pickRow}>
          <View style={styles.pickHeaderRow}>
            <Text style={styles.marketLabel}>{market.toUpperCase()}</Text>
          </View>
          <Text style={styles.noPickText}>{emptyLabel}</Text>
        </View>
      );
    }

    return (
      <View key={market} style={styles.pickRow}>
        <View style={styles.pickHeaderRow}>
          <Text style={styles.marketLabel}>{market.toUpperCase()}</Text>
          {/* R6: model-line picks are never published, so only real book lines
              (main or alternate) can appear here. */}
          <Text style={styles.lineKind}>{pick.isMain ? 'MAIN LINE' : 'ALTERNATE'}</Text>
        </View>

        <View style={styles.selectionRow}>
          <Text style={styles.selectionText}>{pick.selection}</Text>
          <Text style={styles.oddsText}>
            {pick.odds != null ? `${pick.odds.toFixed(2)}` : '—'}
          </Text>
        </View>

        <View style={styles.projectedTotalRow}>
          <Text style={styles.projectedTotalLabel}>Projected Total:</Text>
          <Text style={styles.projectedTotalValue}>{projection.total ?? '—'} points</Text>
        </View>

        <View style={styles.barRow}>
          <ProbabilityBar probability={pick.probability} color={color} />
        </View>

        <View style={styles.badgeRow}>
          <ConfidenceBadge tier={pick.confidence} />
          <ValueTag edge={pick.edge} />
          {pick.ev != null && (
            <View style={styles.evTag}>
              <Text style={styles.evTagText}>EV {(pick.ev * 100).toFixed(1)}%</Text>
            </View>
          )}
        </View>

        {pick.reasoning ? <Text style={styles.reasoningText}>{pick.reasoning}</Text> : null}

        <LineMovedIndicator movement={movements[`${pick.market}|${pick.selection}`]} />
      </View>
    );
  };

  return (
    <TouchableOpacity
      style={styles.card}
      activeOpacity={onPress ? 0.85 : 1}
      onPress={handlePress}
      disabled={!onPress}
    >
      {/* Header */}
      <View style={styles.cardHeader}>
        <View style={styles.leagueBadge}>
          <Text style={styles.leagueText} numberOfLines={1}>{prediction.league || 'Basketball'}</Text>
        </View>
        <Text style={styles.tipoffText}>{formatTipoff(prediction.tipoff)}</Text>
      </View>

      {/* Teams + projected score */}
      <View style={styles.teamsRow}>
        <View style={styles.teamWrapper}>
          {homeLogo ? (
            <Image source={{ uri: homeLogo }} style={styles.teamLogo} />
          ) : (
            <View style={[styles.teamLogo, styles.placeholderLogo]}>
              <Ionicons name="basketball" size={moderateScale(20)} color={theme.textSecondary} />
            </View>
          )}
          <Text style={styles.teamName} numberOfLines={2}>{homeName}</Text>
        </View>

        <View style={styles.scoreWrapper}>
          {score.homePoints != null && score.awayPoints != null ? (
            <Text style={styles.projectedScore}>
              {Math.round(score.homePoints)} - {Math.round(score.awayPoints)}
            </Text>
          ) : (
            <Text style={styles.vsText}>VS</Text>
          )}
          <Text style={styles.projectedLabel}>PROJECTED</Text>
        </View>

        <View style={styles.teamWrapper}>
          {awayLogo ? (
            <Image source={{ uri: awayLogo }} style={styles.teamLogo} />
          ) : (
            <View style={[styles.teamLogo, styles.placeholderLogo]}>
              <Ionicons name="basketball" size={moderateScale(20)} color={theme.textSecondary} />
            </View>
          )}
          <Text style={styles.teamName} numberOfLines={2}>{awayName}</Text>
        </View>
      </View>

      {/* Projection strip */}
      <View style={styles.projectionStrip}>
        <View style={styles.projectionItem}>
          <Text style={styles.projectionLabel}>TOTAL</Text>
          <Text style={styles.projectionValue}>{projection.total ?? '—'}</Text>
        </View>
        <View style={styles.projectionDivider} />
        <View style={styles.projectionItem}>
          <Text style={styles.projectionLabel}>MARGIN</Text>
          <Text style={styles.projectionValue}>
            {projection.margin != null && projection.margin > 0 ? '+' : ''}{projection.margin ?? '—'}
          </Text>
        </View>
        <View style={styles.projectionDivider} />
        <View style={styles.projectionItem}>
          <Text style={styles.projectionLabel}>DATA QUALITY</Text>
          <Text style={styles.projectionValue}>
            {Number.isFinite(dq) ? `${Math.round(dq * 100)}%` : '—'}
          </Text>
        </View>
      </View>

      {/* Picks */}
      <View style={styles.picksSection}>
        {resolveMarketViews(prediction).map(renderPick)}
      </View>

      {/* Risk flags */}
      {riskFlags.length > 0 && (
        <View style={styles.flagsContainer}>
          <Ionicons name="alert-circle-outline" size={moderateScale(13)} color={theme.warning || '#F59E0B'} style={{ marginRight: 5, marginTop: 2 }} />
          <View style={{ flex: 1 }}>
            {riskFlags.map((flag, i) => (
              <Text key={i} style={styles.flagText}>{flag}</Text>
            ))}
          </View>
        </View>
      )}

      {/* Why this pick */}
      <WhyThisPick prediction={prediction} />

      {onPress && (
        <View style={styles.cardFooter}>
          <Text style={styles.footerText}>Tap for full analysis</Text>
          <Ionicons name="chevron-forward-circle" size={moderateScale(18)} color={theme.primary} />
        </View>
      )}
    </TouchableOpacity>
  );
}

const createStyles = (theme) => StyleSheet.create({
  card: {
    backgroundColor: theme.cardBg,
    borderRadius: 14,
    padding: moderateScale(14),
    marginBottom: verticalScale(12),
    borderWidth: 1,
    borderColor: theme.border,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: verticalScale(12),
  },
  leagueBadge: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: moderateScale(8),
    paddingVertical: moderateScale(3),
    borderRadius: 6,
    maxWidth: '70%',
  },
  leagueText: {
    fontSize: getResponsiveFontSize(11),
    fontWeight: '700',
    color: theme.textSecondary,
  },
  tipoffText: {
    fontSize: getResponsiveFontSize(11),
    color: theme.textSecondary,
  },
  teamsRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  teamWrapper: {
    alignItems: 'center',
    width: '30%',
  },
  teamLogo: {
    width: moderateScale(44),
    height: moderateScale(44),
    borderRadius: moderateScale(22),
    marginBottom: verticalScale(6),
  },
  placeholderLogo: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  teamName: {
    fontSize: getResponsiveFontSize(12),
    fontWeight: '600',
    color: theme.text,
    textAlign: 'center',
  },
  scoreWrapper: {
    alignItems: 'center',
    width: '34%',
    paddingTop: verticalScale(8),
  },
  projectedScore: {
    fontSize: getResponsiveFontSize(20),
    fontWeight: '800',
    color: theme.text,
  },
  vsText: {
    fontSize: getResponsiveFontSize(16),
    fontWeight: '700',
    color: theme.textSecondary,
  },
  projectedLabel: {
    marginTop: verticalScale(2),
    fontSize: getResponsiveFontSize(9),
    letterSpacing: 0.8,
    fontWeight: '700',
    color: theme.textSecondary,
  },
  projectionStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: verticalScale(14),
    paddingVertical: verticalScale(9),
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  projectionItem: {
    flex: 1,
    alignItems: 'center',
  },
  projectionDivider: {
    width: 1,
    height: verticalScale(24),
    backgroundColor: theme.border,
  },
  projectionLabel: {
    fontSize: getResponsiveFontSize(9),
    letterSpacing: 0.6,
    fontWeight: '700',
    color: theme.textSecondary,
  },
  projectionValue: {
    marginTop: verticalScale(3),
    fontSize: getResponsiveFontSize(15),
    fontWeight: '800',
    color: theme.text,
  },
  picksSection: {
    marginTop: verticalScale(12),
  },
  pickRow: {
    borderTopWidth: 1,
    borderTopColor: theme.border,
    paddingTop: verticalScale(10),
    marginTop: verticalScale(10),
  },
  pickHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  marketLabel: {
    fontSize: getResponsiveFontSize(10),
    letterSpacing: 0.8,
    fontWeight: '800',
    color: theme.secondary,
  },
  lineKind: {
    fontSize: getResponsiveFontSize(9),
    letterSpacing: 0.5,
    fontWeight: '700',
    color: theme.textSecondary,
  },
  selectionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: verticalScale(6),
  },
  selectionText: {
    flex: 1,
    fontSize: getResponsiveFontSize(16),
    fontWeight: '700',
    color: theme.text,
  },
  oddsText: {
    fontSize: getResponsiveFontSize(14),
    fontWeight: '700',
    color: theme.textSecondary,
  },
  projectedTotalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: verticalScale(4),
  },
  projectedTotalLabel: {
    fontSize: getResponsiveFontSize(11),
    fontWeight: '600',
    color: theme.textSecondary,
  },
  projectedTotalValue: {
    fontSize: getResponsiveFontSize(13),
    fontWeight: '700',
    color: theme.primary,
  },
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: verticalScale(8),
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: moderateScale(6),
    marginTop: verticalScale(8),
  },
  evTag: {
    paddingHorizontal: moderateScale(7),
    paddingVertical: moderateScale(3),
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.border,
  },
  evTagText: {
    fontSize: getResponsiveFontSize(10),
    fontWeight: '700',
    color: theme.textSecondary,
  },
  reasoningText: {
    marginTop: verticalScale(7),
    fontSize: getResponsiveFontSize(12),
    color: theme.textSecondary,
    lineHeight: getResponsiveFontSize(17),
  },
  noPickText: {
    marginTop: verticalScale(6),
    fontSize: getResponsiveFontSize(13),
    fontStyle: 'italic',
    color: theme.textSecondary,
  },
  flagsContainer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: verticalScale(10),
  },
  flagText: {
    fontSize: getResponsiveFontSize(11),
    color: theme.warning || '#F59E0B',
    lineHeight: getResponsiveFontSize(16),
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: verticalScale(12),
    paddingTop: verticalScale(10),
    borderTopWidth: 1,
    borderTopColor: theme.border,
  },
  footerText: {
    fontSize: getResponsiveFontSize(11),
    color: theme.textSecondary,
  },
});
