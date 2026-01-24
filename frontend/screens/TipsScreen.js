import React from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, SafeAreaView } from 'react-native';
import { COLORS } from '../constants/colors';
import { Ionicons } from '@expo/vector-icons';

const TIPS_DATA = [
  {
    id: '1',
    match: 'Arsenal vs Liverpool',
    league: 'Premier League',
    tip: 'Both Teams to Score',
    odds: '1.65',
    confidence: 'High',
    time: '12:30 PM',
    status: 'Pending',
  },
  {
    id: '2',
    match: 'Lakers vs Warriors',
    league: 'NBA',
    tip: 'Lakers -4.5',
    odds: '1.90',
    confidence: 'Medium',
    time: '03:00 AM',
    status: 'Pending',
  },
  {
    id: '3',
    match: 'Real Madrid vs Barcelona',
    league: 'La Liga',
    tip: 'Over 2.5 Goals',
    odds: '1.75',
    confidence: 'High',
    time: '08:00 PM',
    status: 'Pending',
  },
];

export default function TipsScreen() {
  const renderTipItem = ({ item }) => (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <Text style={styles.leagueText}>{item.league}</Text>
        <View style={styles.statusBadge}>
          <Text style={styles.statusText}>{item.status}</Text>
        </View>
      </View>
      
      <Text style={styles.matchText}>{item.match}</Text>
      <Text style={styles.timeText}>{item.time}</Text>
      
      <View style={styles.divider} />
      
      <View style={styles.predictionRow}>
        <View>
          <Text style={styles.label}>Prediction</Text>
          <Text style={styles.predictionText}>{item.tip}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <Text style={styles.label}>Odds</Text>
          <Text style={styles.oddsText}>{item.odds}</Text>
        </View>
      </View>
      
      <View style={styles.confidenceContainer}>
        <Text style={styles.label}>Confidence: </Text>
        <Text style={[
          styles.confidenceText, 
          { color: item.confidence === 'High' ? COLORS.success : COLORS.accent }
        ]}>{item.confidence}</Text>
      </View>
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Expert Tips</Text>
        <TouchableOpacity style={styles.filterButton}>
          <Ionicons name="filter" size={24} color={COLORS.primary} />
        </TouchableOpacity>
      </View>
      
      <FlatList
        data={TIPS_DATA}
        renderItem={renderTipItem}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    backgroundColor: COLORS.bg,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: 'bold',
    color: COLORS.text,
  },
  filterButton: {
    padding: 8,
    backgroundColor: COLORS.cardBg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.primary,
  },
  listContent: {
    padding: 20,
    paddingTop: 0,
  },
  card: {
    backgroundColor: COLORS.cardBg,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(98, 129, 65, 0.3)', // COLORS.primary with opacity
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  leagueText: {
    color: COLORS.secondary,
    fontWeight: '600',
    fontSize: 14,
  },
  statusBadge: {
    backgroundColor: 'rgba(235, 213, 171, 0.2)', // COLORS.accent with opacity
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  statusText: {
    color: COLORS.accent,
    fontSize: 12,
    fontWeight: 'bold',
  },
  matchText: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 4,
  },
  timeText: {
    color: COLORS.textSecondary,
    fontSize: 14,
    marginBottom: 12,
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    marginBottom: 12,
  },
  predictionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  label: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginBottom: 4,
  },
  predictionText: {
    color: COLORS.primary,
    fontSize: 16,
    fontWeight: 'bold',
  },
  oddsText: {
    color: COLORS.white,
    fontSize: 16,
    fontWeight: 'bold',
  },
  confidenceContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  confidenceText: {
    fontWeight: 'bold',
    fontSize: 14,
  },
});
