import React, { useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Animated, AccessibilityInfo } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { moderateScale, getResponsiveFontSize, verticalScale } from '../utils/responsive';

/** Normalise the data-quality penalties payload (array of {reason,value} or object) into rows. */
function penaltyRows(penalties) {
  if (!penalties) return [];
  const fmt = (p) => {
    if (p == null) return null;
    if (typeof p === 'string') return p;
    if (typeof p === 'object') return p.reason || p.label || null;
    return String(p);
  };
  if (Array.isArray(penalties)) return penalties.map(fmt).filter(Boolean);
  return Object.entries(penalties).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'number' ? v.toFixed(2) : v}`);
}

/**
 * Expandable "Why this pick" panel. Surfaces the model's real adjustments
 * (key_factors), risk flags, projection uncertainty and data-quality penalties.
 * Nothing here is hardcoded.
 */
export default function WhyThisPick({ prediction }) {
  const { theme } = useTheme();
  const styles = createStyles(theme);
  const [expanded, setExpanded] = useState(false);
  const anim = useRef(new Animated.Value(0)).current;

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    const run = (reduce) => Animated.timing(anim, {
      toValue: next ? 1 : 0,
      duration: reduce ? 0 : 220,
      useNativeDriver: true,
    }).start();
    if (AccessibilityInfo?.isReduceMotionEnabled) {
      AccessibilityInfo.isReduceMotionEnabled().then(run).catch(() => run(false));
    } else {
      run(false);
    }
  };

  if (!prediction) return null;

  const factors = Array.isArray(prediction.key_factors) ? prediction.key_factors : [];
  const flags = Array.isArray(prediction.risk_flags) ? prediction.risk_flags : [];
  const penalties = penaltyRows(prediction.data_quality_penalties);
  const projection = prediction.projection || {};

  const hasContent = factors.length > 0 || flags.length > 0 || penalties.length > 0;

  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.header} onPress={toggle} activeOpacity={0.7}>
        <Ionicons name="bulb-outline" size={moderateScale(15)} color={theme.secondary} style={{ marginRight: 6 }} />
        <Text style={styles.headerText}>Why this pick</Text>
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={moderateScale(16)}
          color={theme.textSecondary}
        />
      </TouchableOpacity>

      {expanded && (
        <Animated.View
          style={{
            opacity: anim,
            transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-6, 0] }) }],
          }}
        >
          <Text style={styles.projectionLine}>
            Projection: total {projection.total ?? '-'} (σ {projection.sigma_total ?? '-'}) · margin{' '}
            {projection.margin != null && projection.margin > 0 ? '+' : ''}{projection.margin ?? '-'} (σ {projection.sigma_margin ?? '-'})
          </Text>

          {factors.length > 0 && (
            <>
              <Text style={styles.sectionLabel}>Adjustments applied</Text>
              {factors.map((f, i) => (
                <View key={`f_${i}`} style={styles.factorRow}>
                  <Ionicons name="git-commit-outline" size={moderateScale(12)} color={theme.secondary} style={{ marginRight: 6, marginTop: 2 }} />
                  <Text style={styles.factorText}>
                    <Text style={{ fontWeight: '700' }}>{f.type}</Text>
                    {f.team ? ` (${f.team})` : ''}: {f.effect}
                    {Array.isArray(f.notes) && f.notes.length > 0 ? ` — ${f.notes.join('; ')}` : ''}
                  </Text>
                </View>
              ))}
            </>
          )}

          {flags.length > 0 && (
            <>
              <Text style={styles.sectionLabel}>Risk flags</Text>
              {flags.map((flag, i) => (
                <View key={`rf_${i}`} style={styles.factorRow}>
                  <Ionicons name="alert-circle-outline" size={moderateScale(12)} color={theme.warning || '#F59E0B'} style={{ marginRight: 6, marginTop: 2 }} />
                  <Text style={styles.factorText}>{flag}</Text>
                </View>
              ))}
            </>
          )}

          {penalties.length > 0 && (
            <>
              <Text style={styles.sectionLabel}>Data-quality penalties</Text>
              {penalties.map((p, i) => (
                <Text key={`p_${i}`} style={styles.penaltyText}>• {p}</Text>
              ))}
            </>
          )}

          {!hasContent && (
            <Text style={styles.factorText}>
              No material adjustments were applied — the pick is driven by the base ratings and pace projection.
            </Text>
          )}
        </Animated.View>
      )}
    </View>
  );
}

const createStyles = (theme) => StyleSheet.create({
  container: {
    borderTopWidth: 1,
    borderTopColor: theme.border,
    marginTop: verticalScale(10),
    paddingTop: verticalScale(8),
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  headerText: {
    flex: 1,
    fontSize: getResponsiveFontSize(13),
    fontWeight: '700',
    color: theme.text,
  },
  projectionLine: {
    marginTop: verticalScale(8),
    fontSize: getResponsiveFontSize(11),
    color: theme.textSecondary,
    lineHeight: getResponsiveFontSize(16),
  },
  sectionLabel: {
    marginTop: verticalScale(9),
    marginBottom: verticalScale(3),
    fontSize: getResponsiveFontSize(10),
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: theme.secondary,
  },
  factorRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: verticalScale(4),
  },
  factorText: {
    flex: 1,
    fontSize: getResponsiveFontSize(12),
    color: theme.textSecondary,
    lineHeight: getResponsiveFontSize(17),
  },
  penaltyText: {
    fontSize: getResponsiveFontSize(12),
    color: theme.textSecondary,
    lineHeight: getResponsiveFontSize(17),
  },
});
