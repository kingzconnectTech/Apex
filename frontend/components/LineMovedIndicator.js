import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { moderateScale, getResponsiveFontSize } from '../utils/responsive';

/**
 * "Line moved" indicator. Renders only when a real previous/current line pair
 * is supplied (movement is detected upstream). Absent data -> nothing renders,
 * so the UI never fabricates a movement.
 */
export default function LineMovedIndicator({ movement, color = '#F59E0B' }) {
  if (!movement || !movement.moved) return null;
  const delta = Number(movement.delta);
  const up = Number.isFinite(delta) ? delta > 0 : true;
  return (
    <View style={[styles.wrapper, { borderColor: color, backgroundColor: `${color}22` }]}>
      <Ionicons
        name={up ? 'trending-up' : 'trending-down'}
        size={moderateScale(12)}
        color={color}
        style={{ marginRight: 4 }}
      />
      <Text style={[styles.text, { color }]}>
        Line moved {movement.from} → {movement.to}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: moderateScale(8),
    paddingVertical: moderateScale(3),
    borderRadius: 6,
    borderWidth: 1,
    marginTop: moderateScale(6),
  },
  text: {
    fontSize: getResponsiveFontSize(10),
    fontWeight: '700',
  },
});
