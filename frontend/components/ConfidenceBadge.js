import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { moderateScale, getResponsiveFontSize } from '../utils/responsive';

const TIER_COLORS = {
  High: '#10B981',
  Medium: '#F59E0B',
  Low: '#9CA3AF',
};

const TIER_ICONS = {
  High: 'shield-checkmark',
  Medium: 'shield-half',
  Low: 'shield-outline',
};

/**
 * Confidence tier badge. Tiers describe data quality + validation status only —
 * they are never a "certainty" signal.
 */
export default function ConfidenceBadge({ tier }) {
  const key = TIER_COLORS[tier] ? tier : 'Low';
  const color = TIER_COLORS[key];
  return (
    <View style={[styles.badge, { borderColor: color, backgroundColor: `${color}22` }]}>
      <Ionicons name={TIER_ICONS[key]} size={moderateScale(11)} color={color} style={{ marginRight: 3 }} />
      <Text style={[styles.text, { color }]}>{key.toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
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
    letterSpacing: 0.5,
  },
});
