import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { horizontalScale, verticalScale, moderateScale, getResponsiveFontSize } from '../utils/responsive';
import {
  formatMatchDateTime,
  formatConfidence,
  statusLabel,
  statusMeta,
  statusToneColor,
  confidenceBand,
  VISIBILITY,
} from '../utils/adminPicksView';

const BAND_COLOR = {
  high: '#4CAF50',
  medium: '#FFC107',
  low: '#FF7043',
};

/**
 * A single administrator prediction, rendered identically wherever it appears.
 * Shows only the fields stored on the document — never a placeholder number.
 */
export default function AdminPickCard({ pick, showVisibility = false }) {
  const { theme } = useTheme();
  const styles = createStyles(theme);

  if (!pick) return null;

  const when = formatMatchDateTime(pick.matchDate);
  const confidence = formatConfidence(pick.confidence);
  const band = confidenceBand(pick.confidence);
  const statusColor = statusToneColor(theme, pick.status);
  const meta = statusMeta(pick.status);
  const isDraft = pick.visibility === VISIBILITY.DRAFT;

  return (
    <View style={[styles.card, { backgroundColor: theme.cardBg, borderColor: theme.border }]}>
      {/* League / sport + status */}
      <View style={styles.topRow}>
        <View style={styles.leagueWrap}>
          <View style={[styles.sportPill, { backgroundColor: theme.bg }]}>
            <Ionicons
              name={pick.sport === 'Basketball' ? 'basketball-outline' : 'football-outline'}
              size={moderateScale(12)}
              color={theme.secondary}
            />
            <Text style={[styles.sportText, { color: theme.secondary }]}>{pick.sport}</Text>
          </View>
          <Text style={[styles.leagueText, { color: theme.textSecondary }]} numberOfLines={1}>
            {pick.league}
          </Text>
        </View>

        <View style={styles.badgeColumn}>
          {showVisibility && isDraft && (
            <View style={[styles.draftPill, { borderColor: theme.warning || theme.accent }]}>
              <Text style={[styles.draftText, { color: theme.warning || theme.accent }]}>DRAFT</Text>
            </View>
          )}
          <View style={[styles.statusPill, { borderColor: statusColor }]}>
            <Ionicons name={meta.icon} size={moderateScale(12)} color={statusColor} />
            <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel(pick.status)}</Text>
          </View>
        </View>
      </View>

      {/* Teams */}
      <Text style={[styles.teams, { color: theme.text }]} numberOfLines={2}>
        {pick.homeTeam} <Text style={{ color: theme.textSecondary }}>vs</Text> {pick.awayTeam}
      </Text>

      {/* Date / time */}
      {when && (
        <View style={styles.metaRow}>
          <Ionicons name="calendar-outline" size={moderateScale(13)} color={theme.textSecondary} />
          <Text style={[styles.metaText, { color: theme.textSecondary }]}>
            {when.date} · {when.time}
          </Text>
        </View>
      )}

      {/* Market / selection / confidence */}
      <View style={[styles.predictionBox, { backgroundColor: theme.bg }]}>
        <View style={styles.predictionRow}>
          <Text style={[styles.marketLabel, { color: theme.textSecondary }]}>Market</Text>
          <Text style={[styles.marketValue, { color: theme.text }]} numberOfLines={1}>{pick.market}</Text>
        </View>
        <View style={styles.predictionRow}>
          <Text style={[styles.marketLabel, { color: theme.textSecondary }]}>Selection</Text>
          <Text style={[styles.selectionValue, { color: theme.accent }]} numberOfLines={2}>{pick.selection}</Text>
        </View>
        {confidence && (
          <View style={styles.predictionRow}>
            <Text style={[styles.marketLabel, { color: theme.textSecondary }]}>Confidence</Text>
            <View style={styles.confidenceWrap}>
              <View style={[styles.confidenceBar, { backgroundColor: theme.border }]}>
                <View
                  style={[
                    styles.confidenceFill,
                    {
                      width: `${Math.max(0, Math.min(100, Number(pick.confidence) || 0))}%`,
                      backgroundColor: BAND_COLOR[band] || theme.primary,
                    },
                  ]}
                />
              </View>
              <Text style={[styles.confidenceValue, { color: theme.text }]}>{confidence}</Text>
            </View>
          </View>
        )}
      </View>

      {/* Analysis */}
      {pick.analysis ? (
        <Text style={[styles.analysis, { color: theme.textSecondary }]}>{pick.analysis}</Text>
      ) : null}
    </View>
  );
}

const createStyles = theme => StyleSheet.create({
  card: {
    borderRadius: moderateScale(16),
    borderWidth: 1,
    padding: moderateScale(16),
    marginBottom: verticalScale(14),
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: verticalScale(10),
  },
  leagueWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: horizontalScale(8),
  },
  sportPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: moderateScale(8),
    paddingHorizontal: horizontalScale(8),
    paddingVertical: verticalScale(3),
    marginRight: horizontalScale(8),
  },
  sportText: {
    fontSize: getResponsiveFontSize(11),
    fontWeight: '600',
    marginLeft: horizontalScale(4),
  },
  leagueText: {
    flexShrink: 1,
    fontSize: getResponsiveFontSize(13),
    fontWeight: '500',
  },
  badgeColumn: {
    alignItems: 'flex-end',
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: moderateScale(20),
    paddingHorizontal: horizontalScale(10),
    paddingVertical: verticalScale(3),
  },
  statusText: {
    fontSize: getResponsiveFontSize(11),
    fontWeight: '700',
    marginLeft: horizontalScale(4),
    textTransform: 'uppercase',
  },
  draftPill: {
    borderWidth: 1,
    borderRadius: moderateScale(6),
    paddingHorizontal: horizontalScale(6),
    paddingVertical: verticalScale(1),
    marginBottom: verticalScale(4),
  },
  draftText: {
    fontSize: getResponsiveFontSize(9),
    fontWeight: '700',
  },
  teams: {
    fontSize: getResponsiveFontSize(18),
    fontWeight: '700',
    marginBottom: verticalScale(6),
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: verticalScale(10),
  },
  metaText: {
    fontSize: getResponsiveFontSize(12),
    marginLeft: horizontalScale(6),
  },
  predictionBox: {
    borderRadius: moderateScale(12),
    padding: moderateScale(12),
  },
  predictionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginVertical: verticalScale(3),
  },
  marketLabel: {
    fontSize: getResponsiveFontSize(12),
    fontWeight: '600',
    marginRight: horizontalScale(10),
  },
  marketValue: {
    flexShrink: 1,
    fontSize: getResponsiveFontSize(13),
    fontWeight: '500',
    textAlign: 'right',
  },
  selectionValue: {
    flexShrink: 1,
    fontSize: getResponsiveFontSize(14),
    fontWeight: '700',
    textAlign: 'right',
  },
  confidenceWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
  },
  confidenceBar: {
    width: horizontalScale(70),
    height: verticalScale(6),
    borderRadius: moderateScale(3),
    overflow: 'hidden',
    marginRight: horizontalScale(8),
  },
  confidenceFill: {
    height: '100%',
    borderRadius: moderateScale(3),
  },
  confidenceValue: {
    fontSize: getResponsiveFontSize(13),
    fontWeight: '700',
  },
  analysis: {
    marginTop: verticalScale(12),
    fontSize: getResponsiveFontSize(13),
    lineHeight: getResponsiveFontSize(19),
  },
});
