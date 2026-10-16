import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { moderateScale, getResponsiveFontSize } from '../utils/responsive';

/**
 * Horizontal probability meter. The fill width is set directly from the model
 * probability (no animation, so there is no layout thrash). Colour communicates
 * the market side, never a certainty.
 */
export default function ProbabilityBar({ probability = 0, color = '#10B981', height = 8 }) {
  const pct = Math.max(0, Math.min(1, Number(probability) || 0));
  return (
    <View style={styles.wrapper}>
      <View style={[styles.track, { height: moderateScale(height) }]}>
        <View
          style={[
            styles.fill,
            { width: `${pct * 100}%`, backgroundColor: color, height: moderateScale(height) },
          ]}
        />
      </View>
      <Text style={[styles.pct, { color }]}>{Math.round(pct * 100)}%</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  track: {
    flex: 1,
    borderRadius: 999,
    backgroundColor: 'rgba(128,128,128,0.25)',
    overflow: 'hidden',
  },
  fill: {
    borderRadius: 999,
  },
  pct: {
    marginLeft: moderateScale(8),
    fontSize: getResponsiveFontSize(12),
    fontWeight: '700',
    minWidth: moderateScale(38),
    textAlign: 'right',
  },
});
