import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { moderateScale, getResponsiveFontSize } from '../utils/responsive';

/**
 * Edge / value tag. Shows the model probability minus the de-vigged fair
 * implied probability. Only rendered when an edge value actually exists.
 */
export default function ValueTag({ edge, minEdge = 0.04 }) {
  if (edge == null || !Number.isFinite(Number(edge))) return null;
  const edgePct = Number(edge) * 100;
  const hasValue = Number(edge) >= minEdge;
  const color = hasValue ? '#10B981' : '#9CA3AF';
  return (
    <View style={[styles.tag, { borderColor: color, backgroundColor: `${color}22` }]}>
      <Ionicons name="trending-up" size={moderateScale(11)} color={color} style={{ marginRight: 3 }} />
      <Text style={[styles.text, { color }]}>
        {edgePct >= 0 ? '+' : ''}{edgePct.toFixed(1)}% EDGE
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: moderateScale(7),
    paddingVertical: moderateScale(3),
    borderRadius: 6,
    borderWidth: 1,
  },
  text: {
    fontSize: getResponsiveFontSize(10),
    fontWeight: '800',
    letterSpacing: 0.4,
  },
});
